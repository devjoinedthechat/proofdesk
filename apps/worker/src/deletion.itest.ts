import { randomBytes } from "node:crypto";
import { callMcpTool, listMcpTools } from "@proofdesk/agent";
import { createBillingApp } from "@proofdesk/billing";
import {
  type AppDatabase,
  asRole,
  connect,
  DB_ROLES,
  TEST_ROLE_PASSWORD,
  testPostgresUrl,
  verifyAudit,
} from "@proofdesk/db";
import { createDispatch, deletionWorkflowId, runningWorkflows } from "@proofdesk/dispatch";
import { createEntitlementsApp } from "@proofdesk/entitlements";
import { call, invoicesSeen, listInvoices } from "@proofdesk/evals";
import { MockProvider, type MockStep } from "@proofdesk/gateway";
import {
  bearerToken,
  CLIENTS,
  connectKeycloakAdmin,
  createGrantSigner,
  createTokenClient,
  createTokenVerifier,
  createToolTokenSource,
  deleteCustomerAccount,
  deleteRealm,
  generateGrantKey,
  type KeycloakAdmin,
  principalFrom,
  provisionCustomer,
  provisionRealm,
  realmIssuer,
  SCOPES,
  TokenError,
  testKeycloakUrl,
} from "@proofdesk/identity";
import { createBillingMcpApp } from "@proofdesk/mcp-billing";
import { createEntitlementsMcpApp } from "@proofdesk/mcp-entitlements";
import { createToolPolicy, invoiceRecords } from "@proofdesk/policy";
import { createPortalApp } from "@proofdesk/portal";
import {
  baseWorld,
  createSimEnv,
  loadWorld,
  materialise,
  REFUND_SCENARIOS,
  type SimEnv,
} from "@proofdesk/simulator";
import { projectFor, startInspection } from "@proofdesk/telemetry";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection, type Worker } from "@temporalio/worker";
import { type Kysely, sql } from "kysely";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createActivities, type TicketRef } from "./activities.ts";
import { createDeletionActivities, type DeletionReport, mcpErasers } from "./deletion.ts";
import { inspectModelCalls } from "./inspection.ts";
import { testTemporalAddress } from "./testing.ts";
import { createTicketWorker } from "./worker.ts";
import { progress } from "./workflows.ts";

// A customer asks to be deleted, and afterwards every store is searched for
// them. Real Keycloak, Postgres, Temporal and Phoenix, the store of full
// conversations; the portal, both services and both MCP servers run in this
// process; the model is scripted.
//
// The customer first builds up a history worth deleting: one ticket resolved
// with a refund, and one still waiting for staff when the request arrives.

const PASSWORD = "simulation-only-password";
const GRANT_ISSUER = "https://grants.proofdesk.test";
/** A word that appears only in what this customer wrote or was told. */
const MARK = "ZEBRAQUARTZ7731";
const BILLING_MCP = "http://billing-mcp.test";
const ENTITLEMENTS_MCP = "http://entitlements-mcp.test";

const spec = REFUND_SCENARIOS.find((candidate) => candidate.id === "refund-duplicate-with-invoice");
if (!spec) throw new Error("The scenario this test builds on is missing");
const target = materialise(spec, baseWorld());
const { customer, tenant } = target;
const bystander = baseWorld().customers.find(
  (candidate) => candidate.tenantId === tenant.id && candidate.id !== customer.id,
);
if (!bystander) throw new Error("The base world has no second customer in this tenant");

const realm = `del_${randomBytes(4).toString("hex")}`;
const issuer = realmIssuer(testKeycloakUrl(), realm);
const taskQueue = `del-${randomBytes(4).toString("hex")}`;
const suffix = `-${taskQueue}`;

const PHOENIX_KEY = "test-only-phoenix-admin-secret-0123456789";
let phoenix: StartedTestContainer;
let phoenixUrl = "";
let inspection: ReturnType<typeof startInspection>;

/** Every span the inspection store holds for this company, as text. */
async function conversations(): Promise<string> {
  const response = await fetch(
    `${phoenixUrl}/v1/projects/${projectFor(tenant.id)}/spans?limit=1000`,
    { headers: { authorization: `Bearer ${PHOENIX_KEY}` } },
  );
  // No project yet means no conversations yet.
  return response.status === 404 ? "" : response.text();
}

let admin: KeycloakAdmin;
let env: SimEnv;
let portal: ReturnType<typeof createPortalApp>;
let workerDb: Kysely<AppDatabase>;
let portalDb: Kysely<AppDatabase>;
let grantsDb: Kysely<AppDatabase>;
let connection: Connection;
let native: NativeConnection;
let client: Client;
let worker: Worker;
let running: Promise<void>;
let deletion: ReturnType<typeof createDeletionActivities>;
let listToolsFor: (ticketId: string, scopes: string[]) => Promise<string[]>;
/** Advances the portal's idea of the real time, to make a sign-in look old. */
let minutesLater = 0;

async function signIn(email: string): Promise<string | undefined> {
  const response = await fetch(`${issuer}/protocol/openid-connect/token`, {
    method: "POST",
    body: new URLSearchParams({
      client_id: CLIENTS.devLogin,
      grant_type: "password",
      username: email,
      password: PASSWORD,
    }),
  });
  return ((await response.json()) as { access_token?: string }).access_token;
}

async function post(path: string, body: unknown, email = customer.email) {
  return portal.fetch(
    new Request(`http://portal.test${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await signIn(email)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
}

async function submitTicket(subject: string, body: string): Promise<string> {
  const response = await post("/tickets", { category: "refund", subject, body });
  expect(response.status).toBe(201);
  return ((await response.json()) as { ticket: { id: string } }).ticket.id;
}

/** Every row of every table of one database, as text. */
async function dump(db: Kysely<never>): Promise<string> {
  const tables = await sql<{ name: string }>`
    select table_name as name from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE'
  `.execute(db);
  let text = "";
  for (const { name } of tables.rows) {
    const rows = await sql<{ row: string }>`
      select to_jsonb(t)::text as row from ${sql.table(name)} t
    `.execute(db);
    text += rows.rows.map((entry) => `${name}: ${entry.row}\n`).join("");
  }
  return text;
}

async function history(workflowId: string): Promise<string> {
  const raw = JSON.stringify(await client.workflow.getHandle(workflowId).fetchHistory());
  return raw.replace(/"data":"([A-Za-z0-9+/=]+)"/g, (_match, data: string) =>
    Buffer.from(data, "base64").toString("utf8"),
  );
}

const count = async (db: Kysely<never>, table: string, where: ReturnType<typeof sql>) => {
  const result = await sql<{ n: string }>`
    select count(*) as n from ${sql.table(table)} where ${where}
  `.execute(db);
  return Number(result.rows[0]?.n);
};
const app = () => env.dbs.app as unknown as Kysely<never>;
const billing = () => env.dbs.billing as unknown as Kysely<never>;
const entitlements = () => env.dbs.entitlements as unknown as Kysely<never>;

// The scripted model. Ticket one: find the duplicate, refund it, resolve.
// Ticket two: ask to refund the other payment, which will need approval.
const script: MockStep[] = [
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
    reply: `I have refunded $87.00 for the duplicate charge. Reference ${MARK}-REPLY.`,
  }),
  listInvoices(),
  (request) => {
    const payment = invoicesSeen(request).find((invoice) => invoice.payments.length === 2)
      ?.payments[0];
    return call("create_refund", {
      paymentId: payment?.id,
      amountCents: payment?.amountCents,
      reason: "customer_request",
    });
  },
];

let firstTicket = "";
let secondTicket = "";
let report: DeletionReport;
let keptBefore: { invoices: number; payments: number; refunds: number };
let bystanderBefore: string;

beforeAll(async () => {
  admin = await connectKeycloakAdmin({
    url: testKeycloakUrl(),
    username: "admin",
    password: "admin",
  });
  const key = await generateGrantKey();
  await provisionRealm(admin, {
    realm,
    grantIssuer: GRANT_ISSUER,
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

  phoenix = await new GenericContainer("arizephoenix/phoenix:version-21.1.0")
    .withExposedPorts(6006)
    .withEnvironment({
      PHOENIX_ENABLE_AUTH: "true",
      PHOENIX_SECRET: "test-only-phoenix-signing-secret-0123456789abcdef",
      PHOENIX_ADMIN_SECRET: PHOENIX_KEY,
    })
    .withWaitStrategy(Wait.forHttp("/healthz", 6006))
    .start();
  phoenixUrl = `http://${phoenix.getHost()}:${phoenix.getMappedPort(6006)}`;
  inspection = startInspection({ endpoint: phoenixUrl, apiKey: PHOENIX_KEY });

  env = await createSimEnv(testPostgresUrl());
  await loadWorld({ ...target.added, tickets: [] }, env.dbs);
  // Text the customer typed onto their invoices at checkout.
  await env.dbs.billing
    .updateTable("invoices")
    .set({ reference: `PO ${MARK}` })
    .where("customerId", "=", customer.id)
    .execute();
  for (const person of [customer, bystander]) {
    await provisionCustomer(admin, { ...person, password: PASSWORD }, realm);
  }

  const role = (name: string) => asRole(env.urls.app, name, TEST_ROLE_PASSWORD);
  workerDb = connect<AppDatabase>(role(DB_ROLES.worker));
  portalDb = connect<AppDatabase>(role(DB_ROLES.portal));
  grantsDb = connect<AppDatabase>(role(DB_ROLES.grants));

  connection = await Connection.connect({ address: testTemporalAddress() });
  native = await NativeConnection.connect({ address: testTemporalAddress() });
  client = new Client({ connection, namespace: "default" });

  let sequence = 0;
  const newId = (prefix: string) => `${prefix}_d${randomBytes(3).toString("hex")}${++sequence}`;
  const clock = () => env.now;
  const verifier = (audience: string) => createTokenVerifier({ issuer, audience });
  const authenticate = (audience: string) => {
    const verify = verifier(audience);
    return async (request: Request) => {
      const token = bearerToken(request);
      const verified = token ? await verify(token) : null;
      return verified ? principalFrom(verified, "agent") : null;
    };
  };

  portal = createPortalApp({
    db: portalDb,
    grantsDb,
    verify: verifier(CLIENTS.portal),
    signer: await createGrantSigner({ issuer: GRANT_ISSUER, audience: issuer, key }),
    clock,
    newId,
    wallClock: () => new Date(Date.now() + minutesLater * 60_000),
    dispatch: createDispatch(client, { taskQueue, idSuffix: suffix }),
  });
  const billingApp = createBillingApp({
    db: env.serviceDbs.billing,
    clock,
    newId,
    authenticate: authenticate(CLIENTS.billingApi),
  });
  const entitlementsApp = createEntitlementsApp({
    db: env.serviceDbs.entitlements,
    clock,
    authenticate: authenticate(CLIENTS.entitlementsApi),
  });
  const billingMcp = createBillingMcpApp({
    verify: verifier(CLIENTS.billingMcp),
    tokens: createTokenClient({ issuer, clientId: CLIENTS.billingMcp, clientSecret: "mcp-secret" }),
    billingUrl: "http://billing.test",
    billingFetch: (request) => billingApp.fetch(request),
    resourceUrl: BILLING_MCP,
    issuer,
  });
  const entitlementsMcp = createEntitlementsMcpApp({
    verify: verifier(CLIENTS.entitlementsMcp),
    tokens: createTokenClient({
      issuer,
      clientId: CLIENTS.entitlementsMcp,
      clientSecret: "entitlements-mcp-secret",
    }),
    entitlementsUrl: "http://entitlements.test",
    entitlementsFetch: (request) => entitlementsApp.fetch(request),
    resourceUrl: ENTITLEMENTS_MCP,
    issuer,
  });

  const toolTokens = createToolTokenSource({
    worker: createTokenClient({
      issuer,
      clientId: CLIENTS.worker,
      clientSecret: "worker-secret",
    }),
    portalUrl: "http://portal.test",
    portalFetch: (request) => portal.fetch(request),
  });
  const server = (url: string, ticketId: string) => ({
    url,
    fetch: (request: Request) =>
      (url.startsWith(BILLING_MCP) ? billingMcp : entitlementsMcp).fetch(request),
    tokenFor: async (scope: string) => {
      try {
        return (await toolTokens.forTool({ ticketId, scope })).accessToken;
      } catch (error) {
        if (error instanceof TokenError) return null;
        throw error;
      }
    },
  });
  listToolsFor = async (ticketId, scopes) =>
    (
      await Promise.all(
        [BILLING_MCP, ENTITLEMENTS_MCP].map((url) =>
          listMcpTools({ ...server(`${url}/mcp`, ticketId), scopes }),
        ),
      )
    )
      .flat()
      .map((tool) => tool.definition.name);

  const activities = createActivities({
    db: workerDb,
    gateway: inspectModelCalls(new MockProvider(script), inspection),
    versions: { model: "mock-model", prompt: "test", policy: "test" },
    policy: createToolPolicy(),
    clock,
    inspection,
    async invoices(ref: TicketRef) {
      const result = await callMcpTool(
        server(`${BILLING_MCP}/mcp`, ref.ticketId),
        { name: "list_invoices", scope: SCOPES.billingRead },
        {},
      );
      return invoiceRecords.parse((JSON.parse(result.content) as { invoices: unknown }).invoices);
    },
    tools: {
      list: (ref) =>
        listMcpTools({
          ...server(`${BILLING_MCP}/mcp`, ref.ticketId),
          scopes: [SCOPES.billingRead, SCOPES.billingRefund],
        }),
      call: (ref, tool, input) =>
        callMcpTool(
          server(tool.endpoint, ref.ticketId),
          { name: tool.definition.name, scope: tool.scope },
          input,
        ),
    },
  });
  deletion = createDeletionActivities({
    db: workerDb,
    clock,
    inspection,
    ...mcpErasers(
      (ref, name, tool) =>
        callMcpTool(
          server(`${name === "billing" ? BILLING_MCP : ENTITLEMENTS_MCP}/mcp`, ref.ticketId),
          tool,
          {},
        ),
      { billingErase: SCOPES.billingErase, entitlementsErase: SCOPES.entitlementsErase },
    ),
    identity: { deleteAccount: (customerId) => deleteCustomerAccount(admin, customerId, realm) },
    agents: { running: runningWorkflows(client) },
  });
  worker = await createTicketWorker({
    connection: native,
    namespace: "default",
    taskQueue,
    activities: { ...activities, ...deletion },
  });
  running = worker.run();

  // The history. Ticket one is resolved with a refund.
  firstTicket = await submitTicket(
    `Charged twice ${MARK}`,
    `I am ${customer.name} and my card was charged twice for one invoice. ${MARK}`,
  );
  const first = await client.workflow.getHandle(`ticket-${firstTicket}${suffix}`).result();
  expect(first).toMatchObject({ outcome: "refunded" });

  // Ticket two is still waiting for staff when the request arrives. A daily
  // cap of zero sends its refund to approval.
  await env.dbs.app
    .updateTable("tenants")
    .set({ agentDailyRefundCapCents: 0 })
    .where("id", "=", tenant.id)
    .execute();
  secondTicket = await submitTicket(
    `And the other charge ${MARK}`,
    `Please refund the first charge as well. ${MARK}`,
  );
  const second = client.workflow.getHandle(`ticket-${secondTicket}${suffix}`);
  for (let attempt = 0; attempt < 200; attempt++) {
    if ((await second.query(progress)).phase === "waiting_approval") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect((await second.query(progress)).phase).toBe("waiting_approval");

  keptBefore = {
    invoices: await count(billing(), "invoices", sql`customer_id = ${customer.id}`),
    payments: await count(billing(), "payments", sql`customer_id = ${customer.id}`),
    refunds: await count(billing(), "refunds", sql`true`),
  };
  bystanderBefore = await dump(app()).then((text) =>
    text
      .split("\n")
      .filter((line) => line.includes(bystander.id))
      .join("\n"),
  );
}, 600_000);

afterAll(async () => {
  await inspection?.shutdown();
  await phoenix?.stop();
  worker?.shutdown();
  await running;
  await Promise.all([workerDb?.destroy(), portalDb?.destroy(), grantsDb?.destroy()]);
  await native?.close();
  await connection?.close();
  await env?.dispose();
  await deleteRealm(admin, realm);
});

describe("before the request", () => {
  it("has a history worth deleting, in every store", async () => {
    const everything = [await dump(app()), await dump(billing())].join("\n");
    for (const needle of [customer.email, customer.name, MARK, `${MARK}-REPLY`]) {
      expect(everything).toContain(needle);
    }
    expect(await count(app(), "memories", sql`customer_id = ${customer.id}`)).toBe(1);
    expect(await count(app(), "approvals", sql`customer_id = ${customer.id}`)).toBe(1);
    expect(await count(entitlements(), "entitlements", sql`customer_id = ${customer.id}`)).toBe(1);

    // The inspection store has the conversations in full: that is its job.
    let stored = "";
    const complete = () => stored.includes(`${MARK}-REPLY`) && stored.includes(secondTicket);
    for (let attempt = 0; attempt < 100 && !complete(); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      stored = await conversations();
    }
    for (const needle of [customer.name, MARK, `${MARK}-REPLY`, firstTicket, secondTicket]) {
      expect(stored.includes(needle), `${needle} is not in the inspection store`).toBe(true);
    }
  }, 60_000);

  it("does not let a ticket ask for deletion: it is not something an agent handles", async () => {
    const response = await post("/tickets", {
      category: "data_deletion",
      subject: "Delete me",
      body: "Please delete everything.",
    });
    expect(response.status).toBe(400);
  });

  it("refuses a request that names the wrong email address", async () => {
    const response = await post("/account/deletion-request", { confirmEmail: bystander.email });
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "confirmation_mismatch",
    );
  });

  it("refuses a request from a sign-in that is not fresh", async () => {
    minutesLater = 6;
    try {
      const response = await post("/account/deletion-request", { confirmEmail: customer.email });
      expect(response.status).toBe(401);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        "sign_in_too_old",
      );
    } finally {
      minutesLater = 0;
    }
    expect(await count(app(), "deletion_requests", sql`true`)).toBe(0);
  });

  it("gives the worker no way to delete a customer who has not asked", async () => {
    await expect(
      sql`select erase_customer('del_invented', now())`.execute(workerDb),
    ).rejects.toThrow(/No deletion request/);
    await expect(
      workerDb
        .insertInto("deletionRequests")
        .values({
          id: "del_forged",
          tenantId: tenant.id,
          customerId: customer.id,
          ticketId: firstTicket,
          status: "requested",
          requestedAt: env.now,
          completedAt: null,
          erased: null,
        })
        .execute(),
    ).rejects.toThrow(/permission denied/);
    await expect(
      workerDb.deleteFrom("customers").where("id", "=", customer.id).execute(),
    ).rejects.toThrow(/permission denied/);
    // An ordinary ticket's grant carries no authority to erase anywhere else.
    expect(
      await listToolsFor(firstTicket, [SCOPES.billingErase, SCOPES.entitlementsErase]),
    ).toEqual([]);
  });
});

describe("the request", () => {
  it("is accepted from a fresh sign-in that confirms the account's own email", async () => {
    const response = await post("/account/deletion-request", {
      confirmEmail: customer.email.toUpperCase(),
    });
    expect(response.status).toBe(202);
    const { request } = (await response.json()) as { request: { id: string; status: string } };

    report = await client.workflow.getHandle(deletionWorkflowId(request.id, suffix)).result();

    expect(report).toEqual({
      billing: { subscriptionsCanceled: 1, referencesCleared: keptBefore.invoices },
      entitlements: { entitlements: 1, writes: 0 },
      records: {
        customers: 1,
        // The two refund tickets and the deletion request's own.
        tickets: 3,
        agentRuns: 2,
        approvals: 1,
        memories: 1,
        // The agent's reply on the ticket it resolved.
        messages: 1,
        grants: 3,
        grantAssertions: expect.any(Number),
      },
      signInAccounts: 1,
      // Both tickets' conversations. The deletion request itself has none.
      conversations: 2,
    });
  }, 120_000);
});

describe("after the request", () => {
  it("finds no trace of the person in any database", async () => {
    const stores = {
      app: await dump(app()),
      billing: await dump(billing()),
      entitlements: await dump(entitlements()),
    };
    for (const [store, text] of Object.entries(stores)) {
      for (const needle of [customer.email, customer.name, MARK]) {
        expect(text.includes(needle), `${needle} is still in the ${store} database`).toBe(false);
      }
    }
    // Their id remains only where the record of the deletion and of the
    // agent's refunds needs it, and never next to anything about them.
    const withId = stores.app.split("\n").filter((line) => line.includes(customer.id));
    expect(withId.map((line) => line.split(":")[0])).toEqual(["deletion_requests"]);
    expect(stores.entitlements).not.toContain(customer.id);
  });

  it("finds no trace in the inspection store, which held every word", async () => {
    const stored = await conversations();
    for (const needle of [
      customer.email,
      customer.name,
      MARK,
      firstTicket,
      secondTicket,
      customer.id,
    ]) {
      expect(stored.includes(needle), `${needle} is still in the inspection store`).toBe(false);
    }
  });

  it("finds no trace in the workflow histories, and the waiting ticket's workflow has stopped", async () => {
    const request = await env.dbs.app
      .selectFrom("deletionRequests")
      .selectAll()
      .executeTakeFirstOrThrow();
    for (const id of [
      `ticket-${firstTicket}${suffix}`,
      `ticket-${secondTicket}${suffix}`,
      deletionWorkflowId(request.id, suffix),
    ]) {
      const text = await history(id);
      for (const needle of [customer.email, customer.name, MARK]) {
        expect(text.includes(needle), `${needle} is in the history of ${id}`).toBe(false);
      }
    }
    const waiting = await client.workflow.getHandle(`ticket-${secondTicket}${suffix}`).describe();
    expect(waiting.status.name).toBe("CANCELLED");
    expect(request).toMatchObject({ status: "completed", customerId: customer.id });
  });

  it("leaves no way to sign in", async () => {
    expect(await signIn(customer.email)).toBeUndefined();
    const users = (
      await admin.call(
        "GET",
        `/realms/${realm}/users?email=${encodeURIComponent(customer.email)}&exact=true`,
      )
    ).json<unknown[]>();
    expect(users).toEqual([]);
  });

  it("keeps the payment records the company must keep, with the customer's text removed", async () => {
    expect({
      invoices: await count(billing(), "invoices", sql`customer_id = ${customer.id}`),
      payments: await count(billing(), "payments", sql`customer_id = ${customer.id}`),
      refunds: await count(billing(), "refunds", sql`true`),
    }).toEqual(keptBefore);
    expect(
      await count(
        billing(),
        "invoices",
        sql`customer_id = ${customer.id} and reference is not null`,
      ),
    ).toBe(0);
    expect(
      await count(
        billing(),
        "subscriptions",
        sql`customer_id = ${customer.id} and status <> 'canceled'`,
      ),
    ).toBe(0);
  });

  it("keeps the audit log whole, with a record of the deletion that holds only counts", async () => {
    expect(await verifyAudit(env.dbs.app)).toEqual([]);
    const entries = await env.dbs.app
      .selectFrom("auditLog")
      .select(["event", "detail", "actor"])
      .where("event", "like", "deletion_%")
      .orderBy("seq")
      .execute();
    expect(entries.map((entry) => entry.event)).toEqual(["deletion_started", "deletion_completed"]);
    expect(entries.every((entry) => entry.actor === "system:deletion")).toBe(true);
    expect(JSON.parse(entries[1]?.detail ?? "{}")).toMatchObject({
      records: report.records,
      signInAccounts: 1,
    });
  });

  it("touches nobody else", async () => {
    const after = (await dump(app()))
      .split("\n")
      .filter((line) => line.includes(bystander.id))
      .join("\n");
    expect(after).toBe(bystanderBefore);
    expect(after).toContain(bystander.email);
    expect(await signIn(bystander.email)).toBeDefined();
  });

  it("changes nothing when a step runs again", async () => {
    const request = await env.dbs.app
      .selectFrom("deletionRequests")
      .selectAll()
      .executeTakeFirstOrThrow();
    const ref = {
      requestId: request.id,
      ticketId: request.ticketId,
      tenantId: tenant.id,
      customerId: customer.id,
    };
    expect(await deletion.eraseRecords(ref)).toEqual(report.records);
    expect(await deletion.eraseIdentity(ref)).toBe(0);
    expect(await deletion.eraseConversations({ ref, ticketIds: [firstTicket, secondTicket] })).toBe(
      0,
    );
    expect(await count(app(), "audit_log", sql`event like 'deletion_%'`)).toBe(2);
  });
});
