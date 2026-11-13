import { randomBytes } from "node:crypto";
import type { McpToolDescriptor, ToolOutcome } from "@proofdesk/agent";
import {
  type AppDatabase,
  asRole,
  connect,
  DB_ROLES,
  purgeExpiredMemories,
  TEST_ROLE_PASSWORD,
  testPostgresUrl,
  verifyAudit,
} from "@proofdesk/db";
import { call, invoicesSeen, listInvoices, refundLastPayment, resolveWith } from "@proofdesk/evals";
import { MockProvider, type MockStep, type ModelResponse, ProviderError } from "@proofdesk/gateway";
import { BILLING_TOOLS } from "@proofdesk/mcp-billing";
import { ENTITLEMENTS_TOOLS } from "@proofdesk/mcp-entitlements";
import { createToolPolicy } from "@proofdesk/policy";
import { GRANT_SCOPES } from "@proofdesk/portal";
import { ServiceApiError } from "@proofdesk/service";
import {
  baseWorld,
  createSimEnv,
  diffSnapshots,
  loadWorld,
  materialise,
  PLAN_CHANGE_SCENARIOS,
  REFUND_SCENARIOS,
  type Scenario,
  type SimEnv,
  takeSnapshot,
} from "@proofdesk/simulator";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection, type Worker } from "@temporalio/worker";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createActivities, type TicketRef } from "./activities.ts";
import { testTemporalAddress } from "./testing.ts";
import { createTicketWorker, workflowIdFor } from "./worker.ts";
import { approvalDecided, progress } from "./workflows.ts";

// The ticket workflow on a real Temporal server and a real Postgres, with a
// scripted stand-in for the model. These tests are about durability: what
// happens when workers stop, activities are retried, and people take their time.

const scenario = (id: string): Scenario => {
  const spec = [...REFUND_SCENARIOS, ...PLAN_CHANGE_SCENARIOS].find(
    (candidate) => candidate.id === id,
  );
  if (!spec) throw new Error(`No scenario ${id}`);
  return materialise(spec, baseWorld());
};

const policy = createToolPolicy();
let connection: Connection;
let native: NativeConnection;
let client: Client;

type Setup = Awaited<ReturnType<typeof setup>>;
let current: Setup | undefined;

/** A fresh company with one scenario loaded, and everything a worker needs to act on it. */
async function setup(target: Scenario, steps: MockStep[]) {
  const env: SimEnv = await createSimEnv(testPostgresUrl());
  await loadWorld(target.added, env.dbs);
  const before = await takeSnapshot(env.dbs);
  const db = connect<AppDatabase>(asRole(env.urls.app, DB_ROLES.worker, TEST_ROLE_PASSWORD));

  const ref: TicketRef = {
    ticketId: target.ticket.id,
    tenantId: target.tenant.id,
    customerId: target.customer.id,
  };
  const clients = env.clientsFor({
    tenantId: ref.tenantId,
    actor: "agent",
    subject: `agent:ticket:${ref.ticketId}`,
    customerId: ref.customerId,
    scopes: [
      "billing:read",
      "billing:refund",
      "billing:plan",
      "entitlements:read",
      "entitlements:write",
    ],
  });
  const { billing } = clients;

  const provider = new MockProvider(steps);
  const state = {
    paused: false,
    failAfterRefund: 0,
    refundCalls: 0,
    /** Makes the entitlement write crash this many times, after billing has changed. */
    crashEntitlementWrite: 0,
    /** Makes the undo of a billing change crash this many times. */
    crashRevert: 0,
    calls: [] as string[],
  };
  // Only the tools the ticket's category grants, as the token scopes arrange in production.
  const granted = new Set(GRANT_SCOPES[target.ticket.category]);
  const serviceTools = [
    ...BILLING_TOOLS.map((tool) => ({
      tool,
      run: (input: unknown) => tool.run(billing, ref.customerId, input),
    })),
    ...ENTITLEMENTS_TOOLS.map((tool) => ({
      tool,
      run: (input: unknown) => tool.run(clients.entitlements, ref.customerId, input),
    })),
  ].filter(({ tool }) => granted.has(tool.scope));
  const descriptors: McpToolDescriptor[] = serviceTools.map(({ tool }) => ({
    definition: {
      name: tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.input) as Record<string, unknown>,
    },
    writes: tool.writes,
    scope: tool.scope,
    endpoint: "direct",
  }));

  const activities = createActivities({
    db,
    gateway: provider,
    versions: { model: "mock-model", prompt: "test", policy: "test" },
    policy,
    clock: () => env.now,
    agentPaused: () => state.paused,
    invoices: () => billing.listInvoices(ref.customerId),
    tools: {
      list: async () => descriptors,
      async call(_ref, descriptor, input): Promise<ToolOutcome> {
        const name = descriptor.definition.name;
        const entry = serviceTools.find((candidate) => candidate.tool.name === name);
        if (!entry) throw new Error("unknown tool");
        state.calls.push(name);
        if (name === "set_entitlement" && state.crashEntitlementWrite > 0) {
          state.crashEntitlementWrite -= 1;
          throw new Error("worker lost before access was updated");
        }
        if (name === "revert_subscription_change" && state.crashRevert > 0) {
          state.crashRevert -= 1;
          throw new Error("worker lost before the billing change was undone");
        }
        let outcome: ToolOutcome;
        try {
          outcome = { content: JSON.stringify(await entry.run(input)), isError: false };
        } catch (error) {
          if (!(error instanceof ServiceApiError)) throw error;
          outcome = { content: JSON.stringify({ error: { code: error.code } }), isError: true };
        }
        if (name === "create_refund") {
          state.refundCalls += 1;
          // Simulates a worker that dies after billing paid but before the
          // result was saved.
          if (state.failAfterRefund > 0) {
            state.failAfterRefund -= 1;
            throw new Error("worker lost after the refund was issued");
          }
        }
        return outcome;
      },
    },
  });

  const taskQueue = `test-${randomBytes(4).toString("hex")}`;
  let worker: Worker | undefined;
  let running: Promise<void> | undefined;

  const result = {
    env,
    db,
    ref,
    provider,
    state,
    before,
    taskQueue,
    activities,
    async startWorker() {
      worker = await createTicketWorker({
        connection: native,
        namespace: "default",
        taskQueue,
        activities,
      });
      running = worker.run();
    },
    async stopWorker() {
      worker?.shutdown();
      await running;
      worker = undefined;
    },
    start() {
      return client.workflow.start("ticketWorkflow", {
        args: [ref],
        taskQueue,
        workflowId: `${workflowIdFor(ref.ticketId)}-${taskQueue}`,
      });
    },
    async refunds() {
      const changes = diffSnapshots(before, await takeSnapshot(env.dbs));
      return changes
        .filter((change) => change.table === "billing.refunds" && change.kind === "added")
        .map((change) => ({
          paymentId: change.row.paymentId,
          amountCents: change.row.amountCents,
        }));
    },
    ticket: () =>
      env.dbs.app
        .selectFrom("tickets")
        .selectAll()
        .where("id", "=", ref.ticketId)
        .executeTakeFirstOrThrow(),
    audit: () =>
      env.dbs.app
        .selectFrom("auditLog")
        .selectAll()
        .where("ticketId", "=", ref.ticketId)
        .orderBy("seq")
        .execute(),
    async dispose() {
      await result.stopWorker();
      await db.destroy();
      await env.dispose();
    },
  };
  current = result;
  return result;
}

async function waitFor<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  label: string,
): Promise<T> {
  for (let attempt = 0; attempt < 150; attempt++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

beforeAll(async () => {
  connection = await Connection.connect({ address: testTemporalAddress() });
  native = await NativeConnection.connect({ address: testTemporalAddress() });
  client = new Client({ connection, namespace: "default" });
}, 60_000);

afterEach(async () => {
  await current?.dispose();
  current = undefined;
});

afterAll(async () => {
  await native?.close();
  await connection?.close();
});

const duplicateScript = (): MockStep[] => [
  listInvoices(),
  (request) => {
    const duplicate = invoicesSeen(request)
      .find((invoice) => invoice.payments.length === 2)
      ?.payments.at(-1);
    return call("create_refund", {
      paymentId: duplicate?.id,
      amountCents: duplicate?.amountCents,
      reason: "duplicate_charge",
    });
  },
  call("resolve_ticket", {
    outcome: "refunded",
    reasonCode: "duplicate_charge",
    reply: "I have refunded $87.00 for the duplicate charge.",
  }),
];

const overLimitScript = (final: MockStep): MockStep[] => [
  listInvoices(),
  refundLastPayment("customer_request"),
  final,
];

describe("ticket workflow", () => {
  it("resolves a ticket end to end and records every step", async () => {
    const target = scenario("refund-duplicate-with-invoice");
    const run = await setup(target, duplicateScript());
    await run.startWorker();

    const handle = await run.start();
    const outcome = await handle.result();

    expect(outcome).toEqual({ outcome: "refunded", reasonCode: "duplicate_charge" });
    expect(await run.refunds()).toEqual(target.expected.refunds);
    expect(await run.ticket()).toMatchObject({
      status: "resolved",
      outcome: "refunded",
      reply: "I have refunded $87.00 for the duplicate charge.",
    });

    const audit = await run.audit();
    expect(audit.map((entry) => entry.event)).toEqual([
      "run_started",
      "tool_call",
      "tool_call",
      "run_finished",
    ]);
    expect(JSON.parse(audit[2]?.detail ?? "{}")).toMatchObject({
      tool: "create_refund",
      verdict: "allow",
      failed: false,
      input: { amountCents: 87_00, reason: "duplicate_charge" },
    });
    expect(JSON.parse(audit[0]?.detail ?? "{}")).toMatchObject({
      model: "mock-model",
      prompt: "test",
      policy: "test",
    });
    expect(await verifyAudit(run.env.dbs.app)).toEqual([]);
  }, 60_000);

  it("keeps the ticket's text and the customer's details out of the workflow history", async () => {
    const target = scenario("refund-duplicate-with-invoice");
    const run = await setup(target, duplicateScript());
    await run.startWorker();
    const handle = await run.start();
    await handle.result();

    const history = JSON.stringify(await handle.fetchHistory());
    const decoded = history.replace(/"data":"([A-Za-z0-9+/=]+)"/g, (_match, data: string) =>
      Buffer.from(data, "base64").toString("utf8"),
    );

    expect(decoded).toContain(target.ticket.id);
    for (const secret of [
      target.customer.name,
      target.customer.email,
      "card statement",
      target.ticket.subject,
      "$87.00",
    ]) {
      expect(decoded).not.toContain(secret);
    }
  }, 60_000);

  it("pays exactly once when the worker is lost right after the refund", async () => {
    const target = scenario("refund-duplicate-with-invoice");
    const run = await setup(target, duplicateScript());
    run.state.failAfterRefund = 2;
    await run.startWorker();

    const outcome = await (await run.start()).result();

    // The refund activity ran three times. Billing paid on the first and
    // returned that same refund on the other two.
    expect(run.state.refundCalls).toBe(3);
    expect(outcome.outcome).toBe("refunded");
    expect(await run.refunds()).toEqual(target.expected.refunds);
    const refundEntries = (await run.audit()).filter(
      (entry) => entry.event === "tool_call" && entry.detail.includes("create_refund"),
    );
    expect(refundEntries).toHaveLength(1);
  }, 60_000);

  it("waits for approval across a worker restart, then pays once", async () => {
    const target = scenario("refund-over-limit-approved");
    const run = await setup(
      target,
      overLimitScript(
        resolveWith("refunded", "within_window", (number) => `Refunded $290.00 for ${number}.`),
      ),
    );
    await run.startWorker();
    const handle = await run.start();

    const waiting = await waitFor(
      () => handle.query(progress),
      (value) => value.phase === "waiting_approval",
      "the approval request",
    );
    expect(await run.refunds()).toEqual([]);
    expect((await run.ticket()).status).toBe("waiting_approval");
    const approval = await run.env.dbs.app
      .selectFrom("approvals")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(approval).toMatchObject({
      id: waiting.approvalId,
      status: "pending",
      tool: "create_refund",
    });
    expect(approval.summary).toMatchObject({ amountCents: 290_00 });

    // The worker goes away while the ticket waits. Nothing is lost: the wait
    // lives in the workflow engine, and the conversation in the database.
    await run.stopWorker();
    await handle.signal(approvalDecided, {
      approvalId: waiting.approvalId ?? "",
      decision: "approved",
      decidedBy: "staff:ada",
    });
    await run.startWorker();

    expect(await handle.result()).toEqual({ outcome: "refunded", reasonCode: "within_window" });
    expect(await run.refunds()).toEqual(target.expected.refunds);
    expect(
      await run.env.dbs.app
        .selectFrom("approvals")
        .select(["status", "decidedBy"])
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "approved", decidedBy: "staff:ada" });
    expect((await run.audit()).map((entry) => entry.event)).toEqual([
      "run_started",
      "tool_call",
      "approval_requested",
      "approval_decided",
      "tool_call",
      "run_finished",
    ]);
  }, 90_000);

  it("does not pay when staff reject", async () => {
    const target = scenario("refund-over-limit-rejected");
    const run = await setup(
      target,
      overLimitScript(
        resolveWith(
          "refused",
          "approval_rejected",
          (number) => `Our team declined the refund for ${number}.`,
        ),
      ),
    );
    await run.startWorker();
    const handle = await run.start();
    const waiting = await waitFor(
      () => handle.query(progress),
      (value) => value.phase === "waiting_approval",
      "the approval request",
    );

    await handle.signal(approvalDecided, {
      approvalId: waiting.approvalId ?? "",
      decision: "rejected",
      decidedBy: "staff:ada",
    });
    // A second, contradicting answer arrives late and is ignored.
    await handle.signal(approvalDecided, {
      approvalId: waiting.approvalId ?? "",
      decision: "approved",
      decidedBy: "staff:bob",
    });

    expect(await handle.result()).toEqual({ outcome: "refused", reasonCode: "approval_rejected" });
    expect(await run.refunds()).toEqual([]);
    expect((await run.ticket()).status).toBe("refused");
  }, 90_000);

  it("does not pay an approved refund if the agent was paused in the meantime", async () => {
    const target = scenario("refund-over-limit-approved");
    const run = await setup(
      target,
      overLimitScript(
        resolveWith("handed_to_staff", "other", () => "I have passed this to our team."),
      ),
    );
    await run.startWorker();
    const handle = await run.start();
    const waiting = await waitFor(
      () => handle.query(progress),
      (value) => value.phase === "waiting_approval",
      "the approval request",
    );

    run.state.paused = true;
    await handle.signal(approvalDecided, {
      approvalId: waiting.approvalId ?? "",
      decision: "approved",
      decidedBy: "staff:ada",
    });

    expect((await handle.result()).outcome).toBe("handed_to_staff");
    expect(await run.refunds()).toEqual([]);
    const denied = (await run.audit()).filter((entry) => entry.event === "tool_call").at(-1);
    expect(JSON.parse(denied?.detail ?? "{}")).toMatchObject({
      tool: "create_refund",
      verdict: "deny",
    });
  }, 90_000);

  it("hands the ticket to staff when the model claims a refund it never made", async () => {
    const target = scenario("refund-within-window");
    const run = await setup(target, [
      call("resolve_ticket", {
        outcome: "refunded",
        reasonCode: "within_window",
        reply: "I have refunded $58.00.",
      }),
    ]);
    await run.startWorker();

    const outcome = await (await run.start()).result();

    expect(outcome).toEqual({
      outcome: "handed_to_staff",
      reasonCode: "guard_claims_refund_not_made",
    });
    expect(await run.ticket()).toMatchObject({
      status: "handed_to_staff",
      reply: expect.stringContaining("our team"),
    });
    expect(await run.refunds()).toEqual([]);
  }, 60_000);
});

describe("activities applied twice", () => {
  // The engine may run an activity again after it finished, when the worker
  // died before reporting back. The second run must change nothing.
  it("does not call the model or the tool a second time for a step that is already saved", async () => {
    const target = scenario("refund-duplicate-with-invoice");
    const run = await setup(target, duplicateScript());
    const { activities, ref } = run;

    await activities.startRun(ref);
    await activities.startRun(ref);

    const first = await activities.modelTurn({ ref, step: 0 });
    const again = await activities.modelTurn({ ref, step: 0 });
    expect(again).toEqual(first);
    expect(run.provider.calls).toHaveLength(1);

    await activities.executeNext({ ref, step: 1 });
    await activities.modelTurn({ ref, step: 2 });
    const paid = await activities.executeNext({ ref, step: 3 });
    const paidAgain = await activities.executeNext({ ref, step: 3 });

    expect(paidAgain).toEqual(paid);
    expect(run.state.refundCalls).toBe(1);
    expect(await run.refunds()).toEqual(target.expected.refunds);
    expect((await run.audit()).map((entry) => entry.event)).toEqual([
      "run_started",
      "tool_call",
      "tool_call",
    ]);
  }, 60_000);

  it("lets only one of two overlapping attempts of a step take effect", async () => {
    // Two workers run the same step at once, as can happen when the engine
    // gives up on a slow attempt and starts another. Each gets its own model
    // response. Exactly one is saved, and both report that one.
    let arrived = 0;
    let release: () => void = () => {};
    const bothArrived = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Each model call waits until the other has started, so the two attempts
    // really do overlap.
    const together =
      (response: ReturnType<typeof listInvoices>): MockStep =>
      async () => {
        arrived += 1;
        if (arrived === 2) release();
        await bothArrived;
        return response;
      };
    const run = await setup(scenario("refund-duplicate-with-invoice"), [
      together(listInvoices()),
      // The second response asks for two tools, so the attempts' outputs differ.
      together({
        ...listInvoices(),
        content: [...listInvoices().content, ...call("list_subscriptions", {}).content],
      }),
    ]);
    await run.activities.startRun(run.ref);

    const [a, b] = await Promise.all([
      run.activities.modelTurn({ ref: run.ref, step: 0 }),
      run.activities.modelTurn({ ref: run.ref, step: 0 }),
    ]);

    expect(run.provider.calls).toHaveLength(2);
    expect(a).toEqual(b);
    const saved = await run.env.dbs.app
      .selectFrom("agentRuns")
      .select(["step", "state"])
      .executeTakeFirstOrThrow();
    expect(saved.step).toBe(1);
    expect((saved.state as { messages: unknown[] }).messages).toHaveLength(2);
  }, 60_000);

  it("refuses a step that arrives before the one before it", async () => {
    const run = await setup(scenario("refund-duplicate-with-invoice"), duplicateScript());
    await run.activities.startRun(run.ref);
    await expect(run.activities.modelTurn({ ref: run.ref, step: 3 })).rejects.toThrow(
      /before step 0/,
    );
  }, 60_000);
});

describe("a model that cannot be reached", () => {
  it("hands the ticket to staff with nothing paid, and says so in the audit log", async () => {
    const down = () => new ProviderError("mock", "unavailable", "connection refused");
    const run = await setup(scenario("refund-duplicate-with-invoice"), [
      listInvoices(),
      // Every attempt of the second model turn fails.
      down(),
      down(),
      down(),
      down(),
    ]);
    await run.startWorker();

    const outcome = await (await run.start()).result();

    expect(outcome).toEqual({
      outcome: "handed_to_staff",
      reasonCode: "agent_model_unavailable",
    });
    expect(await run.ticket()).toMatchObject({
      status: "handed_to_staff",
      reply: expect.stringContaining("our team"),
    });
    expect(await run.refunds()).toEqual([]);
    expect(run.provider.remaining).toBe(0);
    expect((await run.audit()).map((entry) => entry.event)).toEqual([
      "run_started",
      "tool_call",
      "run_stopped",
      "run_finished",
    ]);
    expect(await verifyAudit(run.env.dbs.app)).toEqual([]);
  }, 120_000);
});

describe("a turn answered by another model", () => {
  it("is written to the audit log, and a dated name of the configured model is not", async () => {
    const run = await setup(scenario("refund-duplicate-with-invoice"), [
      { ...(listInvoices() as ModelResponse), model: "backup-model" },
      { ...(listInvoices() as ModelResponse), model: "mock-model-20261101" },
    ]);
    const { activities, ref } = run;
    await activities.startRun(ref);

    await activities.modelTurn({ ref, step: 0 });
    await activities.executeNext({ ref, step: 1 });
    await activities.modelTurn({ ref, step: 2 });

    const entries = (await run.audit()).filter(
      (entry) => entry.event === "answered_by_other_model",
    );
    expect(entries.map((entry) => JSON.parse(entry.detail))).toEqual([
      { configured: "mock-model", answeredBy: "backup-model" },
    ]);
  }, 60_000);
});

describe("ticket screening", () => {
  it("records the screen's result and never lets a failing screen stop the run", async () => {
    const run = await setup(scenario("refund-duplicate-with-invoice"), duplicateScript());
    const withScreen = (screen: () => Promise<{ suspicious: boolean; signals: string[] } | null>) =>
      createActivities({
        db: run.db,
        gateway: run.provider,
        versions: { model: "mock-model", prompt: "test", policy: "test" },
        policy,
        clock: () => run.env.now,
        invoices: async () => [],
        tools: { list: async () => [], call: async () => ({ content: "", isError: true }) },
        screen,
      });

    await withScreen(async () => {
      throw new Error("screen model unavailable");
    }).startRun(run.ref);

    const [started, screened] = await run.audit();
    expect(started?.event).toBe("run_started");
    expect(screened).toMatchObject({ event: "ticket_screened", detail: '{"screened":false}' });
  }, 60_000);

  it("writes what the screen found to the audit log", async () => {
    const run = await setup(scenario("refund-pressure-outside-window"), []);
    await createActivities({
      db: run.db,
      gateway: run.provider,
      versions: { model: "mock-model", prompt: "test", policy: "test" },
      policy,
      clock: () => run.env.now,
      invoices: async () => [],
      tools: { list: async () => [], call: async () => ({ content: "", isError: true }) },
      screen: async () => ({ suspicious: true, signals: ["claims_prior_approval_or_exception"] }),
    }).startRun(run.ref);

    const screened = (await run.audit()).find((entry) => entry.event === "ticket_screened");
    expect(JSON.parse(screened?.detail ?? "{}")).toEqual({
      suspicious: true,
      signals: ["claims_prior_approval_or_exception"],
    });
  }, 60_000);
});

describe("memory across tickets", () => {
  const refuse = () => [
    call("resolve_ticket", {
      outcome: "refused",
      reasonCode: "outside_window",
      reply: "That charge is too old to refund.",
    }),
  ];

  /** A second ticket from the same customer, written straight into the database. */
  async function secondTicket(run: Setup, id: string) {
    const first = await run.ticket();
    await run.env.dbs.app
      .insertInto("tickets")
      .values({
        ...first,
        id,
        status: "open",
        outcome: null,
        reasonCode: null,
        reply: null,
        resolvedAt: null,
      })
      .execute();
    return { ...run.ref, ticketId: id };
  }

  it("stores a summary with an owner, a source and an expiry, and none of the ticket's words", async () => {
    const target = scenario("refund-pressure-outside-window");
    const run = await setup(target, refuse());
    const { activities, ref } = run;
    await activities.startRun(ref);
    await activities.modelTurn({ ref, step: 0 });
    await activities.executeNext({ ref, step: 1 });
    await activities.finishRun(ref);

    const [memory] = await run.env.dbs.app.selectFrom("memories").selectAll().execute();
    expect(memory).toMatchObject({
      tenantId: ref.tenantId,
      customerId: ref.customerId,
      sourceTicketId: ref.ticketId,
      kind: "ticket_summary",
      content: {
        category: "refund",
        outcome: "refused",
        reasonCode: "outside_window",
        refundedCents: 0,
      },
    });
    const lifetimeDays =
      ((memory?.expiresAt.getTime() ?? 0) - (memory?.createdAt.getTime() ?? 0)) / 86_400_000;
    expect(lifetimeDays).toBe(365);
    // The ticket claims a manager promised the refund. That claim is not a fact and is not kept.
    const stored = JSON.stringify(memory?.content);
    for (const words of ["promised", "lawyer", "manager", target.ticket.subject]) {
      expect(stored).not.toContain(words);
    }
    expect(Object.keys(memory?.content as object).sort()).toEqual([
      "category",
      "closedAt",
      "outcome",
      "reasonCode",
      "refundedCents",
    ]);
  }, 60_000);

  it("shows the next ticket what happened on the last one, as the system's record", async () => {
    const run = await setup(scenario("refund-outside-window"), [...refuse(), ...refuse()]);
    const { activities, ref } = run;
    await activities.startRun(ref);
    await activities.modelTurn({ ref, step: 0 });
    await activities.executeNext({ ref, step: 1 });
    await activities.finishRun(ref);

    const next = await secondTicket(run, "tkt_second");
    await activities.startRun(next);
    await activities.modelTurn({ ref: next, step: 0 });

    const firstMessage = (index: number) => {
      const block = run.provider.calls[index]?.request.messages[0]?.content[0];
      return block?.type === "text" ? block.text : "";
    };
    expect(firstMessage(0)).not.toContain("Earlier tickets");
    expect(firstMessage(1)).toContain("Earlier tickets from this customer, from our own records");
    expect(firstMessage(1)).toContain(
      "refund ticket, outcome refused (outside_window), nothing refunded.",
    );
  }, 60_000);

  it("leaves out expired memories and other customers' memories", async () => {
    const run = await setup(scenario("refund-outside-window"), refuse());
    const { activities, ref } = run;
    const stranger = await run.env.dbs.app
      .selectFrom("customers")
      .selectAll()
      .where("tenantId", "=", ref.tenantId)
      .where("id", "!=", ref.customerId)
      .executeTakeFirstOrThrow();
    const strangersTicket = await run.env.dbs.app
      .selectFrom("tickets")
      .select("id")
      .where("customerId", "=", stranger.id)
      .executeTakeFirst();
    const old = new Date(run.env.now.getTime() - 400 * 86_400_000);
    const content = JSON.stringify({
      category: "refund",
      outcome: "refunded",
      reasonCode: "within_window",
      refundedCents: 999,
      closedAt: old.toISOString(),
    });
    const first = await run.ticket();
    await run.env.dbs.app
      .insertInto("tickets")
      .values({ ...first, id: "tkt_old", status: "resolved" })
      .execute();
    await run.env.dbs.app
      .insertInto("memories")
      .values([
        {
          id: "mem_expired",
          tenantId: ref.tenantId,
          customerId: ref.customerId,
          kind: "ticket_summary",
          sourceTicketId: "tkt_old",
          content,
          createdAt: old,
          expiresAt: new Date(run.env.now.getTime() - 86_400_000),
        },
        ...(strangersTicket
          ? [
              {
                id: "mem_stranger",
                tenantId: ref.tenantId,
                customerId: stranger.id,
                kind: "ticket_summary" as const,
                sourceTicketId: strangersTicket.id,
                content,
                createdAt: run.env.now,
                expiresAt: new Date(run.env.now.getTime() + 86_400_000),
              },
            ]
          : []),
      ])
      .execute();

    await activities.startRun(ref);
    await activities.modelTurn({ ref, step: 0 });

    const block = run.provider.calls[0]?.request.messages[0]?.content[0];
    expect(block?.type === "text" ? block.text : "").not.toContain("Earlier tickets");
    expect(await purgeExpiredMemories(run.env.dbs.app, run.env.now)).toBe(1);
  }, 60_000);
});

describe("plan change across two systems", () => {
  const changeTo = (planCode: string, seats: number): MockStep[] => [
    call("list_subscriptions", {}),
    (request) => {
      const results = request.messages.flatMap((message) =>
        message.role === "user"
          ? message.content.filter((block) => block.type === "tool_result")
          : [],
      );
      const subscriptions = JSON.parse(results.at(-1)?.content ?? "{}").subscriptions as {
        id: string;
      }[];
      return call("change_plan", { subscriptionId: subscriptions[0]?.id, planCode, seats });
    },
    (request) => {
      const last = request.messages.at(-1);
      const failed =
        last?.role === "user" &&
        last.content.some((block) => block.type === "tool_result" && block.isError);
      return failed
        ? call("resolve_ticket", {
            outcome: "handed_to_staff",
            reasonCode: "other",
            reply: "I could not make the change and have passed this to our team.",
          })
        : call("resolve_ticket", {
            outcome: "plan_changed",
            reasonCode: "plan_changed",
            reply: `Your plan now has ${seats} seats, from your next renewal.`,
          });
    },
  ];

  const systems = async (run: Setup) => {
    const subscription = await run.env.dbs.billing
      .selectFrom("subscriptions as s")
      .innerJoin("plans as p", "p.id", "s.planId")
      .select(["p.code as planCode", "s.seats"])
      .where("s.customerId", "=", run.ref.customerId)
      .executeTakeFirstOrThrow();
    const entitlement = await run.env.dbs.entitlements
      .selectFrom("entitlements")
      .select(["planCode", "seats"])
      .where("customerId", "=", run.ref.customerId)
      .executeTakeFirstOrThrow();
    const changes = await run.env.dbs.billing
      .selectFrom("planChanges")
      .select("status")
      .where("customerId", "=", run.ref.customerId)
      .execute();
    return {
      billing: subscription,
      access: entitlement,
      changes: changes.map((change) => change.status),
    };
  };

  it("changes billing and access together, and shows the model one tool for it", async () => {
    const run = await setup(scenario("plan-add-seats"), changeTo("team-monthly", 5));
    await run.startWorker();

    const outcome = await (await run.start()).result();

    expect(outcome).toEqual({ outcome: "plan_changed", reasonCode: "plan_changed" });
    expect(await systems(run)).toEqual({
      billing: { planCode: "team-monthly", seats: 5 },
      access: { planCode: "team-monthly", seats: 5 },
      changes: ["applied"],
    });
    const shown = run.provider.calls[0]?.request.tools?.map((tool) => tool.name);
    expect(shown).toContain("change_plan");
    for (const hidden of [
      "change_subscription",
      "revert_subscription_change",
      "set_entitlement",
      "create_refund",
    ]) {
      expect(shown).not.toContain(hidden);
    }
    expect((await run.ticket()).status).toBe("resolved");
  }, 60_000);

  it("finishes the change when the worker is lost between the two writes", async () => {
    const run = await setup(scenario("plan-add-seats"), changeTo("team-monthly", 5));
    run.state.crashEntitlementWrite = 2;
    await run.startWorker();

    const outcome = await (await run.start()).result();

    // Billing changed on the first attempt. Each retry asked billing again
    // with the same key and was given the change it had already made.
    expect(run.state.calls.filter((name) => name === "change_subscription")).toHaveLength(3);
    expect(outcome.outcome).toBe("plan_changed");
    expect(await systems(run)).toEqual({
      billing: { planCode: "team-monthly", seats: 5 },
      access: { planCode: "team-monthly", seats: 5 },
      changes: ["applied"],
    });
  }, 60_000);

  it("undoes the billing change when access cannot be updated", async () => {
    const run = await setup(scenario("plan-add-seats"), changeTo("team-monthly", 5));
    // Billing says the subscription is active; entitlements say access is suspended.
    await run.env.dbs.entitlements
      .updateTable("entitlements")
      .set({ status: "suspended" })
      .where("customerId", "=", run.ref.customerId)
      .execute();
    await run.startWorker();

    const outcome = await (await run.start()).result();

    expect(outcome.outcome).toBe("handed_to_staff");
    expect(await systems(run)).toEqual({
      billing: { planCode: "team-monthly", seats: 3 },
      access: { planCode: "team-monthly", seats: 3 },
      changes: ["reverted"],
    });
    const toolResult = JSON.stringify(run.provider.calls.at(-1)?.request.messages.at(-1));
    expect(toolResult).toContain("plan_change_rolled_back");
  }, 60_000);

  it("still ends consistent when the worker is lost during the undo", async () => {
    const run = await setup(scenario("plan-add-seats"), changeTo("team-monthly", 5));
    await run.env.dbs.entitlements
      .updateTable("entitlements")
      .set({ status: "suspended" })
      .where("customerId", "=", run.ref.customerId)
      .execute();
    run.state.crashRevert = 1;
    await run.startWorker();

    await (await run.start()).result();

    expect(await systems(run)).toEqual({
      billing: { planCode: "team-monthly", seats: 3 },
      access: { planCode: "team-monthly", seats: 3 },
      changes: ["reverted"],
    });
  }, 60_000);

  it("hands over a run that says the plan changed when it did not", async () => {
    const run = await setup(scenario("plan-add-seats"), [
      call("resolve_ticket", {
        outcome: "plan_changed",
        reasonCode: "plan_changed",
        reply: "Done, you now have 5 seats.",
      }),
    ]);
    await run.startWorker();

    const outcome = await (await run.start()).result();

    expect(outcome).toEqual({
      outcome: "handed_to_staff",
      reasonCode: "guard_claims_plan_change_not_made",
    });
    expect((await systems(run)).changes).toEqual([]);
  }, 60_000);
});
