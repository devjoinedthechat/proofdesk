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
import { call, invoicesSeen, listInvoices } from "@proofdesk/evals";
import { MockProvider, type MockStep } from "@proofdesk/gateway";
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
import { type Kysely, sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createActivities, type TicketRef } from "./activities.ts";

// The kill switch, from the member of staff who flips it to the agent that
// obeys it. Staff sign in at a real Keycloak and use the portal; the worker
// reads the switch from the database, as it does in production.

const PASSWORD = "simulation-only-password";
const spec = REFUND_SCENARIOS.find((candidate) => candidate.id === "refund-duplicate-with-invoice");
if (!spec) throw new Error("The scenario this test builds on is missing");
const target = materialise(spec, baseWorld());
const HARBOR = target.tenant.id;
const TALLYFIELD = "ten_tallyfield";
const staff = {
  operator: { email: "olu.operator@harbor.test", tenantId: HARBOR, role: "operator" },
  approver: { email: "ada.approver@harbor.test", tenantId: HARBOR, role: "approver" },
  elsewhere: { email: "tess.operator@tallyfield.test", tenantId: TALLYFIELD, role: "operator" },
};

const realm = `ctl_${randomBytes(4).toString("hex")}`;
const issuer = realmIssuer(testKeycloakUrl(), realm);
const ref: TicketRef = {
  ticketId: target.ticket.id,
  tenantId: HARBOR,
  customerId: target.customer.id,
};

let admin: KeycloakAdmin;
let signer: Awaited<ReturnType<typeof createGrantSigner>>;
let env: SimEnv;
let portal: ReturnType<typeof createPortalApp>;
let dbs: Kysely<AppDatabase>[] = [];
let workerDb: Kysely<AppDatabase>;
let before: Awaited<ReturnType<typeof takeSnapshot>>;

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

async function asStaff(email: string, method: "GET" | "POST", body?: unknown) {
  return portal.fetch(
    new Request("http://portal.test/staff/agent-controls", {
      method,
      headers: {
        authorization: `Bearer ${await signIn(email)}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

const flip = async (body: { tool?: string; paused: boolean; reason: string }) => {
  const response = await asStaff(staff.operator.email, "POST", body);
  expect(response.status).toBe(200);
};

const duplicateScript = (): MockStep[] => [
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
    reply: "I have refunded $87.00 for the duplicate charge.",
  }),
];

/** The worker's activities, with the kill switch left to its production default: the database. */
function agent(steps: MockStep[]) {
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
  const provider = new MockProvider(steps);
  const activities = createActivities({
    db: workerDb,
    gateway: provider,
    versions: { model: "mock-model", prompt: "test", policy: "test" },
    policy: createToolPolicy(),
    clock: () => env.now,
    invoices: () => billing.listInvoices(ref.customerId),
    tools: {
      list: async () => descriptors,
      async call(_ref, descriptor, input): Promise<ToolOutcome> {
        const tool = tools.find((candidate) => candidate.name === descriptor.definition.name);
        if (!tool) throw new Error("unknown tool");
        try {
          return {
            content: JSON.stringify(await tool.run(billing, ref.customerId, input)),
            isError: false,
          };
        } catch (error) {
          if (!(error instanceof ServiceApiError)) throw error;
          return { content: JSON.stringify({ error: { code: error.code } }), isError: true };
        }
      },
    },
  });
  return { activities, provider };
}

const refunds = async () =>
  diffSnapshots(before, await takeSnapshot(env.dbs)).filter(
    (change) => change.table === "billing.refunds" && change.kind === "added",
  ).length;

const audit = () =>
  env.dbs.app.selectFrom("auditLog").select(["event", "actor", "detail"]).orderBy("seq").execute();

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
  signer = await createGrantSigner({
    issuer: "https://grants.proofdesk.test",
    audience: issuer,
    key,
  });
  for (const person of Object.values(staff)) {
    await provisionStaff(admin, { ...person, name: "Staff Member", password: PASSWORD }, realm);
  }
  await provisionCustomer(admin, { ...target.customer, password: PASSWORD }, realm);
}, 180_000);

afterAll(async () => {
  await deleteRealm(admin, realm);
});

beforeEach(async () => {
  env = await createSimEnv(testPostgresUrl());
  await loadWorld(target.added, env.dbs);
  before = await takeSnapshot(env.dbs);
  const role = (name: string) =>
    connect<AppDatabase>(asRole(env.urls.app, name, TEST_ROLE_PASSWORD));
  workerDb = role(DB_ROLES.worker);
  const portalDb = role(DB_ROLES.portal);
  const grantsDb = role(DB_ROLES.grants);
  dbs = [workerDb, portalDb, grantsDb];
  portal = createPortalApp({
    db: portalDb,
    grantsDb,
    verify: createTokenVerifier({ issuer, audience: CLIENTS.portal }),
    signer,
    clock: () => env.now,
    newId: (prefix) => `${prefix}_${randomBytes(6).toString("hex")}`,
  });
}, 120_000);

afterEach(async () => {
  await Promise.all(dbs.map((db) => db.destroy()));
  await env.dispose();
});

describe("who may use the kill switch", () => {
  it("is an operator of the same company, and nobody else", async () => {
    const pause = { paused: true, reason: "Refunds look wrong" };

    expect((await asStaff(staff.approver.email, "POST", pause)).status).toBe(403);
    expect((await asStaff(target.customer.email, "POST", pause)).status).toBe(403);
    expect((await asStaff(staff.approver.email, "GET")).status).toBe(403);

    // An operator of another company pauses their own agent, not this one.
    expect((await asStaff(staff.elsewhere.email, "POST", pause)).status).toBe(200);
    const mine = await asStaff(staff.operator.email, "GET");
    expect(await mine.json()).toEqual({ controls: [] });

    const { activities, provider } = agent(duplicateScript());
    await activities.startRun(ref);
    expect(await activities.modelTurn({ ref, step: 0 })).toMatchObject({ stopped: false });
    expect(provider.calls).toHaveLength(1);
  }, 120_000);

  it("refuses a request that is not exactly a switch setting", async () => {
    for (const body of [
      { paused: true },
      { paused: "yes", reason: "x" },
      { paused: true, reason: "x", tool: "DROP TABLE" },
      { paused: true, reason: "x", tenantId: TALLYFIELD },
    ]) {
      expect((await asStaff(staff.operator.email, "POST", body)).status).toBe(400);
    }
  }, 120_000);
});

describe("pausing the whole agent", () => {
  it("stops it before its next model call and hands the ticket to staff", async () => {
    const { activities, provider } = agent(duplicateScript());
    await activities.startRun(ref);
    await activities.modelTurn({ ref, step: 0 });
    await activities.executeNext({ ref, step: 1 });

    // Mid-ticket: the model has read the invoices and is about to refund.
    await flip({ paused: true, reason: "Refunds look wrong" });

    expect(await activities.modelTurn({ ref, step: 2 })).toEqual({ pending: 0, stopped: true });
    expect(provider.calls).toHaveLength(1);
    expect(await activities.finishRun(ref)).toEqual({
      outcome: "handed_to_staff",
      reasonCode: "agent_paused",
    });
    expect(await refunds()).toBe(0);

    const entries = await audit();
    expect(entries.map((entry) => entry.event)).toEqual([
      "run_started",
      "tool_call",
      "agent_paused",
      "run_stopped",
      "run_finished",
    ]);
    expect(entries[2]).toMatchObject({
      actor: expect.stringMatching(/^staff:/),
      detail: JSON.stringify({ scope: "agent", reason: "Refunds look wrong" }),
    });
    expect(await verifyAudit(env.dbs.app)).toEqual([]);
  }, 120_000);

  it("lets it work again once an operator resumes it", async () => {
    await flip({ paused: true, reason: "Checking something" });
    await flip({ paused: false, reason: "Checked, all fine" });

    const { activities } = agent(duplicateScript());
    await activities.startRun(ref);
    await activities.modelTurn({ ref, step: 0 });
    await activities.executeNext({ ref, step: 1 });
    await activities.modelTurn({ ref, step: 2 });
    await activities.executeNext({ ref, step: 3 });
    expect(await refunds()).toBe(1);
  }, 120_000);
});

describe("pausing one tool", () => {
  it("denies that tool, leaves the others working, and approval does not override it", async () => {
    await flip({ tool: "create_refund", paused: true, reason: "Refund amounts look wrong" });
    const { activities } = agent([
      ...duplicateScript().slice(0, 2),
      call("resolve_ticket", {
        outcome: "handed_to_staff",
        reasonCode: "other",
        reply: "I have passed this to our team.",
      }),
    ]);
    await activities.startRun(ref);

    await activities.modelTurn({ ref, step: 0 });
    expect(await activities.executeNext({ ref, step: 1 })).toMatchObject({ status: "done" });
    await activities.modelTurn({ ref, step: 2 });
    const denied = await activities.executeNext({
      ref,
      step: 3,
      approval: { decision: "approved", decidedBy: "staff:someone" },
    });

    expect(denied).toMatchObject({ status: "done" });
    expect(await refunds()).toBe(0);
    const calls = (await audit())
      .filter((entry) => entry.event === "tool_call")
      .map((entry) => JSON.parse(entry.detail) as { tool: string; verdict: string });
    expect(calls).toMatchObject([
      { tool: "list_invoices", verdict: "allow" },
      { tool: "create_refund", verdict: "deny" },
    ]);
  }, 120_000);
});

describe("automation and the switch", () => {
  it("can pause the agent and cannot resume it", async () => {
    const pause = () =>
      sql<{ paused: boolean }>`
        select pause_agent(${HARBOR}, 'agent', 'Too many hand-overs', 'system:watchdog', now()) as paused
      `.execute(workerDb);

    expect((await pause()).rows[0]?.paused).toBe(true);
    // Already paused: nothing changes, and the first reason stands.
    expect((await pause()).rows[0]?.paused).toBe(false);

    const resume = (db: Kysely<AppDatabase>) =>
      db.transaction().execute(async (trx) => {
        await sql`select set_config('app.tenant_id', ${HARBOR}, true)`.execute(trx);
        return trx.updateTable("agentControls").set({ paused: false }).execute();
      });
    await expect(resume(workerDb)).rejects.toThrow(/permission denied/);
    await expect(
      workerDb.deleteFrom("agentControls").where("tenantId", "=", HARBOR).execute(),
    ).rejects.toThrow(/permission denied/);

    const seen = await asStaff(staff.operator.email, "GET");
    expect(await seen.json()).toMatchObject({
      controls: [{ scope: "agent", paused: true, setBy: "system:watchdog" }],
    });

    const { activities, provider } = agent(duplicateScript());
    await activities.startRun(ref);
    expect(await activities.modelTurn({ ref, step: 0 })).toMatchObject({ stopped: true });
    expect(provider.calls).toHaveLength(0);
  }, 120_000);
});
