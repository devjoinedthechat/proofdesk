import { randomBytes } from "node:crypto";
import type { McpToolDescriptor, ToolOutcome } from "@proofdesk/agent";
import {
  type AppDatabase,
  asRole,
  connect,
  DB_ROLES,
  TEST_ROLE_PASSWORD,
  testPostgresUrl,
  verifyAudit,
} from "@proofdesk/db";
import { createDispatch, type Dispatch, ticketWorkflowId } from "@proofdesk/dispatch";
import { call, invoicesSeen, listInvoices } from "@proofdesk/evals";
import type { ModelProvider, ModelRequest } from "@proofdesk/gateway";
import {
  CLIENTS,
  connectKeycloakAdmin,
  createGrantSigner,
  createTokenVerifier,
  deleteRealm,
  generateGrantKey,
  type KeycloakAdmin,
  provisionCustomer,
  provisionRealm,
  provisionStaff,
  realmIssuer,
  testKeycloakUrl,
} from "@proofdesk/identity";
import { BILLING_TOOLS } from "@proofdesk/mcp-billing";
import { createToolPolicy } from "@proofdesk/policy";
import { createPortalApp } from "@proofdesk/portal";
import { ServiceApiError } from "@proofdesk/service";
import {
  baseWorld,
  createSimEnv,
  diffSnapshots,
  loadWorld,
  materialise,
  REFUND_SCENARIOS,
  type SimEnv,
  takeSnapshot,
} from "@proofdesk/simulator";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection, type Worker } from "@temporalio/worker";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createActivities, type TicketRef } from "./activities.ts";
import { testTemporalAddress } from "./testing.ts";
import { createWatchdogActivities } from "./watchdog.ts";
import { createTicketWorker } from "./worker.ts";

// A ticket as a conversation, and as a promise.
//
// The customer can answer the agent's question and the same conversation
// carries on. A member of staff can answer a ticket the agent handed over.
// And a ticket the portal accepted is handled even if the portal could not
// start its workflow at the time.
//
// Real Keycloak, Postgres and Temporal. Tickets come in through the portal.

const PASSWORD = "simulation-only-password";
const spec = REFUND_SCENARIOS.find((candidate) => candidate.id === "refund-duplicate-with-invoice");
if (!spec) throw new Error("The scenario this test builds on is missing");
const target = materialise(spec, baseWorld());
const { customer, tenant } = target;
const stranger = baseWorld().customers.find(
  (candidate) => candidate.tenantId === tenant.id && candidate.id !== customer.id,
);
if (!stranger) throw new Error("The base world has no second customer in this tenant");
const staff = {
  approver: { email: "ada.approver@harbor.test", tenantId: tenant.id, role: "approver" },
  elsewhere: {
    email: "tess.approver@tallyfield.test",
    tenantId: "ten_tallyfield",
    role: "approver",
  },
};

const realm = `cnv_${randomBytes(4).toString("hex")}`;
const issuer = realmIssuer(testKeycloakUrl(), realm);
const taskQueue = `cnv-${randomBytes(4).toString("hex")}`;
const suffix = `-${taskQueue}`;

/** What the customer's later message says, so the scripted model can tell it arrived. */
const ANSWER = "It is the second payment on that invoice. Please refund the duplicate.";
const QUESTION = "Which charge would you like us to look at?";

// A stand-in model that reads the conversation, as a model does:
//   "PLEASE ESCALATE" in the ticket: hand it to staff.
//   the customer has answered: refund the duplicate, then say so.
//   otherwise: look at the invoices, then ask which charge is meant.
const texts = (request: ModelRequest) =>
  request.messages.flatMap((message) =>
    message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])),
  );
let sequence = 0;
const seen: ModelRequest[] = [];
const model: ModelProvider = {
  name: "scripted",
  async complete(request) {
    seen.push(structuredClone(request));
    const said = texts(request).join("\n");
    const invoices = invoicesSeen(request);
    const refunded = request.messages.some((message) =>
      message.content.some(
        (block) => block.type === "tool_result" && block.content.includes('"refund"'),
      ),
    );
    const resolve = (outcome: string, reasonCode: string, reply: string) => ({
      ...call("resolve_ticket", { outcome, reasonCode, reply }),
      id: `resolve_${++sequence}`,
    });
    if (said.includes("PLEASE ESCALATE")) {
      return resolve("handed_to_staff", "other", "I have passed this to our team.");
    }
    if (invoices.length === 0) return listInvoices();
    if (!said.includes(ANSWER)) return resolve("needs_clarification", "invoice_unclear", QUESTION);
    if (!refunded) {
      const payment = invoices.find((invoice) => invoice.payments.length === 2)?.payments.at(-1);
      return call("create_refund", {
        paymentId: payment?.id,
        amountCents: payment?.amountCents,
        reason: "duplicate_charge",
      });
    }
    return resolve(
      "refunded",
      "duplicate_charge",
      "I have refunded $87.00 for the duplicate charge.",
    );
  },
};

let admin: KeycloakAdmin;
let env: SimEnv;
let portal: ReturnType<typeof createPortalApp>;
let dbs: Kysely<AppDatabase>[] = [];
let workerDb: Kysely<AppDatabase>;
let connection: Connection;
let native: NativeConnection;
let client: Client;
let worker: Worker;
let running: Promise<void>;
let before: Awaited<ReturnType<typeof takeSnapshot>>;
let dispatch: Dispatch;
/** When true, the portal cannot reach the workflow engine. */
let engineDown = false;

async function signIn(email: string): Promise<string> {
  const response = await fetch(`${issuer}/protocol/openid-connect/token`, {
    method: "POST",
    body: new URLSearchParams({
      client_id: CLIENTS.devLogin,
      grant_type: "password",
      username: email,
      password: PASSWORD,
    }),
  });
  const body = (await response.json()) as { access_token?: string };
  if (!body.access_token) throw new Error(`Sign-in failed for ${email}`);
  return body.access_token;
}

async function as(email: string, method: "GET" | "POST", path: string, body?: unknown) {
  const response = await portal.fetch(
    new Request(`http://portal.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await signIn(email)}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  // biome-ignore lint/suspicious/noExplicitAny: test reads of loosely shaped JSON
  return { status: response.status, body: (await response.json()) as any };
}

async function file(subject: string, body: string, email = customer.email): Promise<string> {
  const response = await as(email, "POST", "/tickets", { category: "refund", subject, body });
  expect(response.status).toBe(201);
  return response.body.ticket.id;
}

type Seen = {
  id: string;
  status: string;
  reply: string | null;
  messages: { author: string; body: string }[];
};
async function ticket(id: string, email = customer.email): Promise<Seen> {
  const { body } = await as(email, "GET", "/tickets");
  return body.tickets.find((candidate: Seen) => candidate.id === id);
}

async function until(id: string, status: string): Promise<Seen> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const current = await ticket(id);
    if (current?.status === status) return current;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Ticket ${id} never reached ${status}; it is ${(await ticket(id))?.status}`);
}

const refunds = async () =>
  diffSnapshots(before, await takeSnapshot(env.dbs)).filter(
    (change) => change.table === "billing.refunds" && change.kind === "added",
  ).length;

const outbox = (ticketId: string) =>
  env.dbs.app
    .selectFrom("workflowOutbox")
    .select(["kind", "startedAt"])
    .where("ticketId", "=", ticketId)
    .orderBy("createdAt")
    .execute();

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
  for (const person of [customer, stranger]) {
    await provisionCustomer(admin, { ...person, password: PASSWORD }, realm);
  }
  for (const person of Object.values(staff)) {
    await provisionStaff(admin, { ...person, name: "Staff Member", password: PASSWORD }, realm);
  }

  env = await createSimEnv(testPostgresUrl());
  await loadWorld({ ...target.added, tickets: [] }, env.dbs);
  before = await takeSnapshot(env.dbs);
  const role = (name: string) =>
    connect<AppDatabase>(asRole(env.urls.app, name, TEST_ROLE_PASSWORD));
  workerDb = role(DB_ROLES.worker);
  const portalDb = role(DB_ROLES.portal);
  const grantsDb = role(DB_ROLES.grants);
  dbs = [workerDb, portalDb, grantsDb];

  connection = await Connection.connect({ address: testTemporalAddress() });
  native = await NativeConnection.connect({ address: testTemporalAddress() });
  client = new Client({ connection, namespace: "default" });
  dispatch = createDispatch(client, { taskQueue, idSuffix: suffix });

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
    limits: { ticketsPerHour: 6, openTickets: 5 },
    // Every ticket the agent resolved by itself is put up for a check here.
    reviewSamplePercent: 100,
    dispatch: async (job) => {
      if (engineDown) throw new Error("connect ECONNREFUSED: the workflow engine is unreachable");
      return dispatch(job);
    },
  });

  // Each ticket's tools act for that ticket's customer.
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
  const billingFor = (ref: TicketRef) =>
    env.clientsFor({
      tenantId: ref.tenantId,
      actor: "agent",
      subject: `agent:ticket:${ref.ticketId}`,
      customerId: ref.customerId,
      scopes: ["billing:read", "billing:refund"],
    }).billing;
  const activities = createActivities({
    db: workerDb,
    gateway: model,
    versions: { model: "mock-model", prompt: "test", policy: "test" },
    policy: createToolPolicy(),
    clock: () => env.now,
    invoices: (ref) => billingFor(ref).listInvoices(ref.customerId),
    tools: {
      list: async () => descriptors,
      async call(ref, descriptor, input): Promise<ToolOutcome> {
        const tool = tools.find((candidate) => candidate.name === descriptor.definition.name);
        if (!tool) throw new Error("unknown tool");
        try {
          return {
            content: JSON.stringify(await tool.run(billingFor(ref), ref.customerId, input)),
            isError: false,
          };
        } catch (error) {
          if (!(error instanceof ServiceApiError)) throw error;
          return { content: JSON.stringify({ error: { code: error.code } }), isError: true };
        }
      },
    },
  });
  worker = await createTicketWorker({
    connection: native,
    namespace: "default",
    taskQueue,
    activities,
  });
  running = worker.run();
}, 300_000);

afterAll(async () => {
  worker?.shutdown();
  await running;
  await Promise.all(dbs.map((db) => db.destroy()));
  await native?.close();
  await connection?.close();
  await env?.dispose();
  await deleteRealm(admin, realm);
});

describe("a customer answering the agent's question", () => {
  let id = "";

  it("gets a question when the ticket does not say which charge", async () => {
    id = await file("Refund please", "I think I was charged wrongly.");
    const waiting = await until(id, "waiting_customer");

    expect(waiting.reply).toBe(QUESTION);
    expect(waiting.messages).toMatchObject([{ author: "agent", body: QUESTION }]);
    expect(await refunds()).toBe(0);
  }, 120_000);

  it("cannot be done on someone else's ticket, or twice at once", async () => {
    const theirs = await as(stranger.email, "POST", `/tickets/${id}/messages`, { body: "hello" });
    expect(theirs.status).toBe(404);

    const both = await Promise.all([
      as(customer.email, "POST", `/tickets/${id}/messages`, { body: ANSWER }),
      as(customer.email, "POST", `/tickets/${id}/messages`, { body: ANSWER }),
    ]);
    // One reply reopens the ticket. The other finds it no longer waiting.
    expect(both.map((response) => response.status).sort()).toEqual([202, 409]);
  }, 120_000);

  it("carries the same conversation on, and the agent acts on the answer", async () => {
    const done = await until(id, "resolved");

    expect(done.reply).toBe("I have refunded $87.00 for the duplicate charge.");
    expect(done.messages.map((message) => message.author)).toEqual(["agent", "customer", "agent"]);
    expect(done.messages[1]?.body).toBe(ANSWER);
    expect(await refunds()).toBe(1);

    // The model was shown the whole conversation: the ticket, its own
    // question, and the customer's answer wrapped as the customer's text.
    const last = seen.filter((request) => texts(request).join("\n").includes(ANSWER)).at(-1);
    const conversation = last ? texts(last).join("\n") : "";
    expect(conversation).toContain("I think I was charged wrongly.");
    expect(conversation).toMatch(
      /The customer replied on this ticket:\s+<ticket>\s+<body>\s+It is the second payment/,
    );
    // The invoices were read once, in the first round, and not again.
    expect(last?.messages.filter((message) => message.role === "assistant")).toHaveLength(3);

    const events = await env.dbs.app
      .selectFrom("auditLog")
      .select("event")
      .where("ticketId", "=", id)
      .orderBy("seq")
      .execute();
    expect(events.map((entry) => entry.event)).toEqual([
      "run_started",
      "tool_call",
      "run_finished",
      "run_resumed",
      "tool_call",
      "run_finished",
    ]);
    expect(await verifyAudit(env.dbs.app)).toEqual([]);
  }, 120_000);

  it("takes no further reply once the ticket is closed", async () => {
    const late = await as(customer.email, "POST", `/tickets/${id}/messages`, { body: "thanks" });
    expect(late.status).toBe(409);
    expect(await refunds()).toBe(1);
  }, 60_000);
});

describe("a member of staff answering a handed-over ticket", () => {
  let id = "";
  const REPLY = "We have looked into this and applied a credit to your next invoice.";

  it("shows it to an approver of that company, with the conversation so far", async () => {
    id = await file("Something odd", "PLEASE ESCALATE this to a person.");
    await until(id, "handed_to_staff");

    const mine = await as(staff.approver.email, "GET", "/staff/handed-over");
    expect(mine.body.tickets).toMatchObject([
      { id, subject: "Something odd", messages: [{ author: "agent" }] },
    ]);
    const theirs = await as(staff.elsewhere.email, "GET", "/staff/handed-over");
    expect(theirs.body.tickets).toEqual([]);
    expect(
      (
        await as(staff.elsewhere.email, "POST", `/staff/tickets/${id}/reply`, {
          body: REPLY,
          resolution: "resolved",
        })
      ).status,
    ).toBe(404);
  }, 120_000);

  it("closes the ticket with the reply, which the customer then sees", async () => {
    const sent = await as(staff.approver.email, "POST", `/staff/tickets/${id}/reply`, {
      body: REPLY,
      resolution: "resolved",
    });
    expect(sent.status).toBe(201);

    const closed = await ticket(id);
    expect(closed).toMatchObject({ status: "resolved", reply: REPLY });
    expect(closed.messages.map((message) => [message.author, message.body])).toEqual([
      ["agent", "I have passed this to our team."],
      ["staff", REPLY],
    ]);
    expect((await as(staff.approver.email, "GET", "/staff/handed-over")).body.tickets).toEqual([]);

    // Answered once. And a customer cannot use the staff endpoint.
    const again = await as(staff.approver.email, "POST", `/staff/tickets/${id}/reply`, {
      body: "Again",
      resolution: "refused",
    });
    expect(again.status).toBe(409);
    expect(
      (
        await as(customer.email, "POST", `/staff/tickets/${id}/reply`, {
          body: "x",
          resolution: "resolved",
        })
      ).status,
    ).toBe(403);
  }, 60_000);

  it("keeps what the agent did on record, and the reply's words out of the audit log", async () => {
    const row = await env.dbs.app
      .selectFrom("tickets")
      .select(["outcome", "reasonCode", "status"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ outcome: "handed_to_staff", reasonCode: "other", status: "resolved" });

    const entry = await env.dbs.app
      .selectFrom("auditLog")
      .select(["actor", "detail"])
      .where("ticketId", "=", id)
      .where("event", "=", "staff_replied")
      .executeTakeFirstOrThrow();
    expect(entry.actor).toMatch(/^staff:/);
    expect(entry.detail).toBe('{"resolution":"resolved"}');
  }, 60_000);
});

describe("a ticket accepted while the workflow engine is unreachable", () => {
  let id = "";
  const sweeper = () =>
    createWatchdogActivities({ db: workerDb, clock: () => env.now, dispatch, overdueSeconds: -1 });

  it("is accepted anyway, and waits on record", async () => {
    engineDown = true;
    try {
      id = await file("Charged twice", "PLEASE ESCALATE, I was charged twice.");
    } finally {
      engineDown = false;
    }
    expect(await outbox(id)).toEqual([{ kind: "ticket", startedAt: null }]);
    expect((await ticket(id)).status).toBe("open");
    await expect(
      client.workflow.getHandle(ticketWorkflowId(id, suffix)).describe(),
    ).rejects.toThrow();
  }, 60_000);

  it("is started by the sweeper, and handled", async () => {
    expect(await sweeper().dispatchPending()).toBe(1);

    await until(id, "handed_to_staff");
    expect(await outbox(id)).toMatchObject([{ kind: "ticket", startedAt: expect.any(Date) }]);
  }, 120_000);

  it("is not started twice, by the sweeper or by a second attempt at the same work", async () => {
    expect(await sweeper().dispatchPending()).toBe(0);
    // The same job handed over again: the engine already has it.
    expect(
      await dispatch({
        kind: "ticket",
        ref: { ticketId: id, tenantId: tenant.id, customerId: customer.id },
        route: "stable",
      }),
    ).toBe("started");
    const runs = [];
    for await (const run of client.workflow.list({
      query: `WorkflowId = '${ticketWorkflowId(id, suffix)}'`,
    })) {
      runs.push(run.runId);
    }
    expect(runs).toHaveLength(1);
  }, 60_000);

  it("leaves nothing waiting once every ticket has been handled", async () => {
    const waiting = await env.dbs.app
      .selectFrom("workflowOutbox")
      .select("id")
      .where("startedAt", "is", null)
      .execute();
    expect(waiting).toEqual([]);
  });
});

describe("tickets the agent resolved by itself", () => {
  it("are put in front of staff as a check, next to the ones it handed over", async () => {
    const { body } = await as(staff.approver.email, "GET", "/staff/review-queue");
    const byWhy = (why: string) =>
      body.tickets.filter((candidate: { why: string }) => candidate.why === why);

    // The refund the agent made after the customer answered, with its reply
    // and the invoices it read, so a person can judge it.
    expect(byWhy("sample")).toMatchObject([
      {
        outcome: "refunded",
        reasonCode: "duplicate_charge",
        reply: "I have refunded $87.00 for the duplicate charge.",
      },
    ]);
    expect(byWhy("sample")[0].invoices.length).toBeGreaterThan(0);
    expect(byWhy("handed_over").length).toBe(2);

    // A verdict on a sampled ticket is taken like any other.
    const verdict = await as(
      staff.approver.email,
      "POST",
      `/staff/review-queue/${byWhy("sample")[0].id}`,
      { verdict: "agent_right", expectedOutcome: "refunded", expectedReason: "duplicate_charge" },
    );
    expect(verdict.status).toBe(201);
  }, 60_000);
});

describe("one customer asking too much", () => {
  it("is told to wait, and nobody else is affected", async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 8; attempt++) {
      const response = await as(stranger.email, "POST", "/tickets", {
        category: "refund",
        subject: `Request ${attempt}`,
        body: "PLEASE ESCALATE this one.",
      });
      statuses.push(response.status);
      if (response.status === 429) {
        expect(response.body.error.code).toBe("too_many_requests");
      }
    }
    // Some are accepted, then the limit holds for the rest.
    expect(statuses.filter((status) => status === 201).length).toBeGreaterThan(0);
    expect(statuses.filter((status) => status === 201).length).toBeLessThanOrEqual(6);
    expect(statuses.at(-1)).toBe(429);

    // The limit is per customer. Another customer of the same company files as usual.
    const other = await as(customer.email, "POST", "/tickets", {
      category: "refund",
      subject: "One more",
      body: "PLEASE ESCALATE this one as well.",
    });
    expect(other.status).toBe(201);
  }, 120_000);
});
