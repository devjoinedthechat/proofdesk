import type { McpToolDescriptor, ToolOutcome } from "@proofdesk/agent";
import {
  type AppDatabase,
  asRole,
  connect,
  DB_ROLES,
  TEST_ROLE_PASSWORD,
  testPostgresUrl,
} from "@proofdesk/db";
import { call, invoicesSeen, listInvoices } from "@proofdesk/evals";
import {
  createGateway,
  createMemoryLedger,
  MockProvider,
  type MockStep,
  type ModelResponse,
} from "@proofdesk/gateway";
import { BILLING_TOOLS } from "@proofdesk/mcp-billing";
import { createToolPolicy } from "@proofdesk/policy";
import {
  baseWorld,
  createSimEnv,
  loadWorld,
  materialise,
  REFUND_SCENARIOS,
  type SimEnv,
} from "@proofdesk/simulator";
import { createTestTelemetry, METRICS } from "@proofdesk/telemetry";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createActivities, type TicketRef } from "./activities.ts";
import { recordModelCall } from "./telemetry.ts";
import { activityAttributes } from "./worker.ts";

// What leaves the process as telemetry when the agent handles a ticket. A
// ticket is taken from arrival to refund with telemetry kept in memory, and
// everything that would have been exported is then read back.

const spec = REFUND_SCENARIOS.find((candidate) => candidate.id === "refund-duplicate-with-invoice");
if (!spec) throw new Error("The scenario this test builds on is missing");
const target = materialise(spec, baseWorld());
const ref: TicketRef = {
  ticketId: target.ticket.id,
  tenantId: target.tenant.id,
  customerId: target.customer.id,
};
const REPLY = "I have refunded $87.00 for the duplicate charge on your March invoice.";
const usage = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 400, cacheWriteTokens: 0 };
const priced = (step: MockStep): MockStep =>
  typeof step === "function"
    ? async (request, context) => ({ ...(await step(request, context)), usage })
    : { ...(step as ModelResponse), usage };

let env: SimEnv;
let db: Kysely<AppDatabase>;

beforeEach(async () => {
  env = await createSimEnv(testPostgresUrl());
  await loadWorld(target.added, env.dbs);
  db = connect<AppDatabase>(asRole(env.urls.app, DB_ROLES.worker, TEST_ROLE_PASSWORD));
});

afterEach(async () => {
  await db.destroy();
  await env.dispose();
});

async function handleTicket() {
  const test = createTestTelemetry();
  const billing = env.clientsFor({
    tenantId: ref.tenantId,
    actor: "agent",
    subject: `agent:ticket:${ref.ticketId}`,
    customerId: ref.customerId,
    scopes: ["billing:read", "billing:refund"],
  }).billing;
  const tools = BILLING_TOOLS.filter((tool) =>
    ["list_invoices", "create_refund"].includes(tool.name),
  );
  const descriptors: McpToolDescriptor[] = tools.map((tool) => ({
    definition: {
      name: tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.input) as Record<string, unknown>,
    },
    writes: tool.writes,
    scope: tool.scope,
    endpoint: "direct",
  }));
  const steps: MockStep[] = [
    listInvoices(),
    (request) => {
      const payment = invoicesSeen(request)
        .find((invoice) => invoice.payments.length === 2)
        ?.payments.at(-1);
      return call("create_refund", {
        paymentId: payment?.id,
        amountCents: payment?.amountCents,
        reason: "duplicate_charge",
      });
    },
    call("resolve_ticket", {
      outcome: "refunded",
      reasonCode: "duplicate_charge",
      reply: REPLY,
    }),
  ];
  const provider = new MockProvider(steps.map(priced));
  const activities = createActivities({
    db,
    gateway: createGateway({
      routes: [{ provider }],
      prices: { "mock-model": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } },
      ledger: createMemoryLedger(),
      limits: { perTicketMicros: 1_000_000, perTenantMicros: 1_000_000 },
      onCall: (record) => recordModelCall(test.telemetry, record, new Date()),
    }),
    versions: { model: "mock-model", prompt: "test", policy: "test" },
    policy: createToolPolicy(),
    clock: () => env.now,
    telemetry: test.telemetry,
    invoices: () => billing.listInvoices(ref.customerId),
    tools: {
      list: async () => descriptors,
      async call(_ref, descriptor, input): Promise<ToolOutcome> {
        const tool = tools.find((candidate) => candidate.name === descriptor.definition.name);
        if (!tool) throw new Error("unknown tool");
        return {
          content: JSON.stringify(await tool.run(billing, ref.customerId, input)),
          isError: false,
        };
      },
    },
  });

  // Each activity runs inside the span the worker would give it.
  const run = <Result>(name: string, input: unknown, fn: () => Promise<Result>) =>
    test.telemetry.span(`activity.${name}`, activityAttributes(name, input), fn);
  await run("startRun", ref, () => activities.startRun(ref));
  for (const step of [0, 2, 4]) {
    await run("modelTurn", { ref, step }, () => activities.modelTurn({ ref, step }));
    await run("executeNext", { ref, step: step + 1 }, () =>
      activities.executeNext({ ref, step: step + 1 }),
    );
  }
  const outcome = await run("finishRun", ref, () => activities.finishRun(ref));
  return { test, outcome };
}

describe("telemetry for one ticket", () => {
  it("counts what happened, what it cost and what was refunded", async () => {
    const { test, outcome } = await handleTicket();
    expect(outcome).toEqual({ outcome: "refunded", reasonCode: "duplicate_charge" });

    const points = await test.points();
    const events = points
      .filter((point) => point.name === METRICS.events)
      .map((point) => ({ ...point.attributes, count: point.value }));
    expect(events).toEqual(
      expect.arrayContaining([
        { event: "run_started", "tenant.id": ref.tenantId, count: 1 },
        {
          event: "tool_call",
          "tenant.id": ref.tenantId,
          "tool.name": "list_invoices",
          "tool.verdict": "allow",
          "tool.failed": false,
          count: 1,
        },
        {
          event: "tool_call",
          "tenant.id": ref.tenantId,
          "tool.name": "create_refund",
          "tool.verdict": "allow",
          "tool.failed": false,
          count: 1,
        },
        {
          event: "run_finished",
          "tenant.id": ref.tenantId,
          outcome: "refunded",
          reason: "duplicate_charge",
          count: 1,
        },
      ]),
    );
    const total = (name: string) =>
      points
        .filter((point) => point.name === name)
        .reduce((sum, point) => sum + Number(point.value), 0);
    expect(total(METRICS.refundCents)).toBe(87_00);
    expect(total(METRICS.modelCalls)).toBe(3);
    // Three calls, each 1,000 input at $2, 100 output at $10 and 400 cached at $0.20 per million.
    expect(total(METRICS.modelCostMicros)).toBe(3 * 3_080);
    expect(total(METRICS.modelTokens)).toBe(3 * 1_500);
  }, 120_000);

  it("puts every step of the ticket in one trace", async () => {
    const { test } = await handleTicket();
    const spans = test.spans();

    expect(new Set(spans.map((span) => span.traceId)).size).toBe(1);
    expect(spans.map((span) => span.name)).toEqual([
      "ticket",
      "activity.startRun",
      "model.call",
      "activity.modelTurn",
      "activity.executeNext",
      "model.call",
      "activity.modelTurn",
      "activity.executeNext",
      "model.call",
      "activity.modelTurn",
      "activity.executeNext",
      "activity.finishRun",
    ]);
    expect(spans[3]?.attributes).toEqual({
      "activity.name": "modelTurn",
      "ticket.id": ref.ticketId,
      "tenant.id": ref.tenantId,
      "run.step": 0,
    });
  }, 120_000);

  it("exports nothing the customer wrote, nothing they were told and nothing about who they are", async () => {
    const { test } = await handleTicket();
    const exported = await test.everything();

    expect(exported).toContain(ref.ticketId);
    for (const secret of [
      target.customer.name,
      target.customer.email,
      target.customer.email.split("@")[0] ?? "",
      target.ticket.subject,
      "card statement",
      REPLY,
      "duplicate charge on your",
      "$87.00",
    ]) {
      expect(exported.includes(secret), `"${secret}" was exported`).toBe(false);
    }
    // Nothing had to be removed, either: no free text was ever offered.
    expect((await test.points()).filter((point) => point.name === METRICS.redactions)).toEqual([]);
  }, 120_000);
});
