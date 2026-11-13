import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpToolDescriptor } from "@proofdesk/agent";
import {
  type AppDatabase,
  asRole,
  connect,
  DB_ROLES,
  TEST_ROLE_PASSWORD,
  testPostgresUrl,
  verifyAudit,
} from "@proofdesk/db";
import { call, captureCase, caseToSpec, listInvoices, loadCapturedCases } from "@proofdesk/evals";
import { MockProvider } from "@proofdesk/gateway";
import {
  CLIENTS,
  connectKeycloakAdmin,
  createGrantSigner,
  createTokenVerifier,
  deleteRealm,
  generateGrantKey,
  type KeycloakAdmin,
  provisionRealm,
  provisionStaff,
  realmIssuer,
  testKeycloakUrl,
} from "@proofdesk/identity";
import { BILLING_TOOLS } from "@proofdesk/mcp-billing";
import { createToolPolicy } from "@proofdesk/policy";
import { createPortalApp } from "@proofdesk/portal";
import {
  baseWorld,
  createSimEnv,
  loadWorld,
  materialise,
  REFUND_SCENARIOS,
  runScenario,
  type SimEnv,
  type Solver,
} from "@proofdesk/simulator";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createActivities, type TicketRef } from "./activities.ts";

// The feedback loop, end to end. The agent gets a ticket wrong in
// production. A member of staff says what should have happened. One command
// turns that into an eval case, and the case fails on the behaviour that was
// wrong and passes on the behaviour that is right.

const PASSWORD = "simulation-only-password";
const spec = REFUND_SCENARIOS.find((candidate) => candidate.id === "refund-duplicate-with-invoice");
if (!spec) throw new Error("The scenario this test builds on is missing");
const target = materialise(spec, baseWorld());
const { customer, tenant } = target;
const doubled = target.added.invoices.find(
  (invoice) =>
    target.added.payments.filter((payment) => payment.invoiceId === invoice.id).length === 2,
);
const duplicate = target.added.payments
  .filter((payment) => payment.invoiceId === doubled?.id)
  .at(-1);
if (!doubled || !duplicate) throw new Error("The scenario has no duplicate payment");

const ref: TicketRef = { ticketId: target.ticket.id, tenantId: tenant.id, customerId: customer.id };
const staff = {
  approver: { email: "ada.approver@harbor.test", tenantId: tenant.id, role: "approver" },
  operator: { email: "olu.operator@harbor.test", tenantId: tenant.id, role: "operator" },
  elsewhere: {
    email: "tess.approver@tallyfield.test",
    tenantId: "ten_tallyfield",
    role: "approver",
  },
};
const realm = `rev_${randomBytes(4).toString("hex")}`;
const issuer = realmIssuer(testKeycloakUrl(), realm);

let admin: KeycloakAdmin;
let env: SimEnv;
let portal: ReturnType<typeof createPortalApp>;
let dbs: Kysely<AppDatabase>[] = [];

async function asStaff(email: string, method: "GET" | "POST", path: string, body?: unknown) {
  const signIn = await fetch(`${issuer}/protocol/openid-connect/token`, {
    method: "POST",
    body: new URLSearchParams({
      client_id: CLIENTS.devLogin,
      grant_type: "password",
      username: email,
      password: PASSWORD,
    }),
  });
  const { access_token: token } = (await signIn.json()) as { access_token: string };
  const response = await portal.fetch(
    new Request(`http://portal.test${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const verdict = {
  verdict: "agent_wrong",
  expectedOutcome: "refunded",
  expectedReason: "duplicate_charge",
  expectedRefunds: [{ paymentId: duplicate.id, amountCents: duplicate.amountCents }],
};

beforeAll(async () => {
  admin = await connectKeycloakAdmin({
    url: testKeycloakUrl(),
    username: "admin",
    password: "admin",
  });
  const key = await generateGrantKey();
  await provisionRealm(admin, {
    realm,
    grantIssuer: "https://grants.proofdesk.test",
    grantPublicKey: key.publicKeySpki,
    grantKeyId: key.kid,
    secrets: {
      worker: "worker-secret",
      billingMcp: "mcp-secret",
      entitlementsMcp: "entitlements-mcp-secret",
    },
    devLogin: true,
    insecureHttp: true,
  });
  for (const person of Object.values(staff)) {
    await provisionStaff(admin, { ...person, name: "Staff Member", password: PASSWORD }, realm);
  }

  env = await createSimEnv(testPostgresUrl());
  await loadWorld(target.added, env.dbs);
  // The customer wrote their own name and email address into the ticket, as
  // people do.
  await env.dbs.app
    .updateTable("tickets")
    .set({
      subject: `Charged twice, ${doubled.number}`,
      body: `Hello, this is ${customer.name} (${customer.email}). Invoice ${doubled.number} was taken from my card twice. ${customer.name.split(" ")[0]} here would like the second one back. My assistant is at pat.lee@elsewhere.example.`,
    })
    .where("id", "=", ref.ticketId)
    .execute();

  const role = (name: string) =>
    connect<AppDatabase>(asRole(env.urls.app, name, TEST_ROLE_PASSWORD));
  const workerDb = role(DB_ROLES.worker);
  const portalDb = role(DB_ROLES.portal);
  const grantsDb = role(DB_ROLES.grants);
  dbs = [workerDb, portalDb, grantsDb];
  portal = createPortalApp({
    db: portalDb,
    grantsDb,
    verify: createTokenVerifier({ issuer, audience: CLIENTS.portal }),
    signer: await createGrantSigner({
      issuer: "https://grants.proofdesk.test",
      audience: issuer,
      key,
    }),
    clock: () => env.now,
    newId: (prefix) => `${prefix}_${randomBytes(6).toString("hex")}`,
  });

  // The agent in production: it reads the invoices, sees the duplicate, and
  // gives up instead of refunding it.
  const billing = env.clientsFor({
    tenantId: ref.tenantId,
    actor: "agent",
    subject: `agent:ticket:${ref.ticketId}`,
    customerId: ref.customerId,
    scopes: ["billing:read", "billing:refund"],
  }).billing;
  const tool = BILLING_TOOLS.find((candidate) => candidate.name === "list_invoices");
  if (!tool) throw new Error("list_invoices is missing");
  const descriptor: McpToolDescriptor = {
    definition: {
      name: tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.input) as Record<string, unknown>,
    },
    writes: false,
    scope: tool.scope,
    endpoint: "direct",
  };
  const activities = createActivities({
    db: workerDb,
    gateway: new MockProvider([
      listInvoices(),
      call("resolve_ticket", {
        outcome: "handed_to_staff",
        reasonCode: "other",
        reply: "I have passed this to our team.",
      }),
    ]),
    versions: { model: "mock-model", prompt: "test", policy: "test" },
    policy: createToolPolicy(),
    clock: () => env.now,
    invoices: () => billing.listInvoices(ref.customerId),
    tools: {
      list: async () => [descriptor],
      call: async (_ref, _descriptor, input) => ({
        content: JSON.stringify(await tool.run(billing, ref.customerId, input)),
        isError: false,
      }),
    },
  });
  await activities.startRun(ref);
  await activities.modelTurn({ ref, step: 0 });
  await activities.executeNext({ ref, step: 1 });
  await activities.modelTurn({ ref, step: 2 });
  await activities.executeNext({ ref, step: 3 });
  expect(await activities.finishRun(ref)).toEqual({
    outcome: "handed_to_staff",
    reasonCode: "other",
  });
}, 300_000);

afterAll(async () => {
  await Promise.all(dbs.map((db) => db.destroy()));
  await env?.dispose();
  await deleteRealm(admin, realm);
});

describe("the review queue", () => {
  it("shows a handed-over ticket to an approver of that company and to nobody else", async () => {
    const mine = await asStaff(staff.approver.email, "GET", "/staff/review-queue");
    expect(mine.status).toBe(200);
    expect(mine.body.tickets).toMatchObject([
      { id: ref.ticketId, category: "refund", reasonCode: "other" },
    ]);

    const theirs = await asStaff(staff.elsewhere.email, "GET", "/staff/review-queue");
    expect(theirs.body.tickets).toEqual([]);
    expect((await asStaff(staff.operator.email, "GET", "/staff/review-queue")).status).toBe(403);
    expect(
      (await asStaff(staff.elsewhere.email, "POST", `/staff/review-queue/${ref.ticketId}`, verdict))
        .status,
    ).toBe(404);
  });

  it("takes a verdict made of fixed words, identifiers and amounts, and nothing else", async () => {
    for (const bad of [
      { ...verdict, note: "The customer was very upset about this." },
      { ...verdict, expectedOutcome: "give them the money" },
      { ...verdict, expectedReason: "Customer is right, refund it" },
      { ...verdict, expectedRefunds: [{ paymentId: duplicate.id, amountCents: -1 }] },
    ]) {
      const response = await asStaff(
        staff.approver.email,
        "POST",
        `/staff/review-queue/${ref.ticketId}`,
        bad,
      );
      expect(response.status).toBe(400);
    }

    const accepted = await asStaff(
      staff.approver.email,
      "POST",
      `/staff/review-queue/${ref.ticketId}`,
      verdict,
    );
    expect(accepted.status).toBe(201);
    const again = await asStaff(
      staff.approver.email,
      "POST",
      `/staff/review-queue/${ref.ticketId}`,
      verdict,
    );
    expect(again.status).toBe(409);

    expect(
      (await asStaff(staff.approver.email, "GET", "/staff/review-queue")).body.tickets,
    ).toEqual([]);
    const entry = await env.dbs.app
      .selectFrom("auditLog")
      .select(["actor", "detail"])
      .where("event", "=", "ticket_reviewed")
      .executeTakeFirstOrThrow();
    expect(entry.actor).toMatch(/^staff:/);
    expect(JSON.parse(entry.detail)).toEqual({
      verdict: "agent_wrong",
      expectedOutcome: "refunded",
      expectedReason: "duplicate_charge",
    });
    expect(await verifyAudit(env.dbs.app)).toEqual([]);
  });
});

describe("from the verdict to an eval case", () => {
  it("captures what the agent saw and what was expected, without the customer", async () => {
    const captured = await captureCase(env.dbs.app, ref.ticketId);
    const text = JSON.stringify(captured);

    for (const personal of [
      customer.name,
      customer.name.split(" ")[0] ?? "",
      customer.email,
      "pat.lee",
      customer.id,
      ref.ticketId,
      duplicate.id,
      doubled.number,
    ]) {
      expect(text.includes(personal), `"${personal}" is in the case`).toBe(false);
    }
    expect(captured).toMatchObject({
      tenant: "harbor",
      textReviewed: false,
      ticket: { subject: "Charged twice, {{invoice:0}}" },
      observed: { outcome: "handed_to_staff", reasonCode: "other" },
      expected: {
        outcome: "refunded",
        reasonCode: "duplicate_charge",
        refunds: [{ invoice: 0, payment: 1, amountCents: 87_00 }],
      },
    });
    expect(captured.ticket.body).toBe(
      "Hello, this is [name] ([email]). Invoice {{invoice:0}} was taken from my card twice. [name] here would like the second one back. My assistant is at [email].",
    );
    expect(captured.invoices).toHaveLength(2);
    expect(captured.invoices[0]?.payments.map((payment) => payment.status)).toEqual([
      "succeeded",
      "succeeded",
    ]);
  });

  it("is not usable until a person has read it", async () => {
    const captured = await captureCase(env.dbs.app, ref.ticketId);
    expect(() => caseToSpec(captured)).toThrow(/has not been read by a person/);

    const directory = mkdtempSync(join(tmpdir(), "cases-"));
    writeFileSync(join(directory, `${captured.id}.json`), JSON.stringify(captured));
    expect(() => loadCapturedCases(directory)).toThrow(/has not been read by a person/);
  });

  it("fails on the behaviour that was wrong and passes on the behaviour that is right", async () => {
    const captured = await captureCase(env.dbs.app, ref.ticketId);
    // A person reads the text, removes what is left, and signs it off.
    const reviewed = {
      ...captured,
      textReviewed: true,
      ticket: {
        ...captured.ticket,
        body: captured.ticket.body.replace(" My assistant is at [email].", ""),
      },
    };
    const scenario = materialise(caseToSpec(reviewed), baseWorld());
    expect(scenario.ticket.body).toContain(scenario.added.invoices[0]?.number);

    const gaveUp: Solver = async () => ({
      outcome: "handed_to_staff",
      reasonCode: "other",
      reply: "I have passed this to our team.",
    });
    const refundsTheDuplicate: Solver = async (context) => {
      const invoices = await context.billing.listInvoices(context.customer.id);
      const paidTwice = invoices.find(
        (invoice) =>
          invoice.payments.filter((payment) => payment.status === "succeeded").length > 1,
      );
      const second = paidTwice?.payments.at(-1);
      if (!second) throw new Error("No duplicate payment in the rebuilt case");
      await context.billing.createRefund(
        { paymentId: second.id, amountCents: second.amountCents, reason: "duplicate_charge" },
        `case:${scenario.ticket.id}`,
      );
      return {
        outcome: "refunded",
        reasonCode: "duplicate_charge",
        reply: `I have refunded $${(second.amountCents / 100).toFixed(2)} for the duplicate charge.`,
      };
    };

    for (const [solver, passes] of [
      [gaveUp, false],
      [refundsTheDuplicate, true],
    ] as const) {
      const fresh = await createSimEnv(testPostgresUrl());
      try {
        const result = await runScenario(fresh, scenario, solver);
        expect(result.passed, result.failures.join("; ")).toBe(passes);
      } finally {
        await fresh.dispose();
      }
    }
  });
});
