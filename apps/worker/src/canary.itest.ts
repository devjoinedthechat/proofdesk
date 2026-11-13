import { randomBytes } from "node:crypto";
import {
  type AppDatabase,
  asRole,
  connect,
  DB_ROLES,
  TEST_ROLE_PASSWORD,
  testPostgresUrl,
  verifyAudit,
} from "@proofdesk/db";
import { type ModelProvider, toolUseResponse } from "@proofdesk/gateway";
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
  realmIssuer,
  testKeycloakUrl,
} from "@proofdesk/identity";
import { createToolPolicy } from "@proofdesk/policy";
import { createPortalApp, routeFor } from "@proofdesk/portal";
import {
  baseWorld,
  createSimEnv,
  loadWorld,
  materialise,
  REFUND_SCENARIOS,
  type SimEnv,
} from "@proofdesk/simulator";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection, type Worker } from "@temporalio/worker";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createActivities } from "./activities.ts";
import { testTemporalAddress } from "./testing.ts";
import { createWatchdogActivities } from "./watchdog.ts";
import { createTicketWorker } from "./worker.ts";

// A bad build goes out as a canary, and nobody is watching. Half of new
// tickets go to it. Its model claims refunds it never made, so the reply
// guard stops every one of its replies. The watchdog has to notice, send all
// new tickets back to the stable build and raise an alert, by itself.
//
// Real Keycloak, Postgres and Temporal. Tickets come in through the portal.
// Two workers run, one per build, each with a scripted model.

const PASSWORD = "simulation-only-password";
const spec = REFUND_SCENARIOS.find((candidate) => candidate.id === "refund-within-window");
if (!spec) throw new Error("The scenario this test builds on is missing");
const target = materialise(spec, baseWorld());
const { customer, tenant } = target;

const realm = `can_${randomBytes(4).toString("hex")}`;
const issuer = realmIssuer(testKeycloakUrl(), realm);
const suffix = randomBytes(4).toString("hex");
const queue = (route: string) => `${route}-${suffix}`;
const FIRST_WAVE = 40;

/** A model that always ends the ticket the same way. */
function alwaysResolves(input: {
  outcome: string;
  reasonCode: string;
  reply: string;
}): ModelProvider {
  let sequence = 0;
  return {
    name: "scripted",
    complete: async () =>
      toolUseResponse({ id: `call_${++sequence}`, name: "resolve_ticket", input }),
  };
}
// The stable build asks a sensible question. The canary says it paid.
const stableModel = alwaysResolves({
  outcome: "needs_clarification",
  reasonCode: "invoice_unclear",
  reply: "Which charge would you like us to look at?",
});
const regressedModel = alwaysResolves({
  outcome: "refunded",
  reasonCode: "within_window",
  reply: "I have refunded $58.00 to your card.",
});

let admin: KeycloakAdmin;
let env: SimEnv;
let portal: ReturnType<typeof createPortalApp>;
let dbs: Kysely<AppDatabase>[] = [];
let connection: Connection;
let native: NativeConnection;
let client: Client;
let workers: { worker: Worker; running: Promise<void> }[] = [];
let token = "";
let ticketNumber = 0;
const routed: { ticketId: string; route: string }[] = [];
const notified: { kind: string; tenantId: string | null }[] = [];

async function submit(): Promise<string> {
  const response = await portal.fetch(
    new Request("http://portal.test/tickets", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        category: "refund",
        subject: "Refund please",
        body: "I would like a refund for my last charge.",
      }),
    }),
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { ticket: { id: string } }).ticket.id;
}

const finished = (ticketId: string) =>
  client.workflow.getHandle(`ticket-${ticketId}-${suffix}`).result() as Promise<{
    outcome: string;
    reasonCode: string;
  }>;

async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, label: string) {
  for (let attempt = 0; attempt < 600; attempt++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const rollout = () =>
  env.dbs.app.selectFrom("rollout").selectAll().where("id", "=", "agent").executeTakeFirstOrThrow();

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
  await provisionCustomer(admin, { ...customer, password: PASSWORD }, realm);

  env = await createSimEnv(testPostgresUrl());
  await loadWorld({ ...target.added, tickets: [] }, env.dbs);
  const role = (name: string) =>
    connect<AppDatabase>(asRole(env.urls.app, name, TEST_ROLE_PASSWORD));
  const workerDb = role(DB_ROLES.worker);
  const portalDb = role(DB_ROLES.portal);
  const grantsDb = role(DB_ROLES.grants);
  dbs = [workerDb, portalDb, grantsDb];

  connection = await Connection.connect({ address: testTemporalAddress() });
  native = await NativeConnection.connect({ address: testTemporalAddress() });
  client = new Client({ connection, namespace: "default" });

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
    // Fixed ids, so which tickets go to the canary is the same on every run.
    newId: (prefix) => `${prefix}_canary_${String(++ticketNumber).padStart(4, "0")}`,
    dispatch: async (job) => {
      if (job.kind !== "ticket") throw new Error("This test only files tickets");
      routed.push({ ticketId: job.ref.ticketId, route: job.route });
      await client.workflow.start("ticketWorkflow", {
        args: [job.ref],
        taskQueue: queue(job.route),
        workflowId: `ticket-${job.ref.ticketId}-${suffix}`,
      });
      return "started";
    },
  });

  const build = (gateway: ModelProvider, version: string) =>
    createActivities({
      db: workerDb,
      gateway,
      versions: { model: "mock-model", prompt: version, policy: "test" },
      policy: createToolPolicy(),
      clock: () => env.now,
      invoices: async () => [],
      tools: { list: async () => [], call: async () => ({ content: "", isError: true }) },
    });
  const watchdog = createWatchdogActivities({
    db: workerDb,
    clock: () => env.now,
    notify: async (alert) => {
      notified.push({ kind: alert.kind, tenantId: alert.tenantId });
    },
  });
  for (const [route, activities] of [
    ["stable", { ...build(stableModel, "build-1"), ...watchdog }],
    ["canary", build(regressedModel, "build-2")],
  ] as const) {
    const worker = await createTicketWorker({
      connection: native,
      namespace: "default",
      taskQueue: queue(route),
      activities,
    });
    workers.push({ worker, running: worker.run() });
  }

  const signIn = await fetch(`${issuer}/protocol/openid-connect/token`, {
    method: "POST",
    body: new URLSearchParams({
      client_id: CLIENTS.devLogin,
      grant_type: "password",
      username: customer.email,
      password: PASSWORD,
    }),
  });
  token = ((await signIn.json()) as { access_token: string }).access_token;
}, 300_000);

afterAll(async () => {
  await client?.workflow
    .getHandle(`watchdog-${suffix}`)
    .terminate()
    .catch(() => {});
  for (const { worker } of workers) worker.shutdown();
  await Promise.all(workers.map(({ running }) => running));
  workers = [];
  await Promise.all(dbs.map((db) => db.destroy()));
  await native?.close();
  await connection?.close();
  await env?.dispose();
  await deleteRealm(admin, realm);
});

describe("a regressed build released as a canary", () => {
  it("gets its share of new tickets, and fails them", async () => {
    // The deploy pipeline starts the canary. Nothing in the running system can.
    await env.dbs.app
      .updateTable("rollout")
      .set({ canaryShare: 50, canaryVersion: "build-2", setBy: "deploy", reason: "Release 2" })
      .execute();

    const ids: string[] = [];
    for (let index = 0; index < FIRST_WAVE; index++) ids.push(await submit());
    const outcomes = await Promise.all(ids.map(finished));

    // The route is decided by the ticket's id and stored with the ticket.
    const expected = ids.map((id) => routeFor(id, 50));
    expect(routed.map((entry) => entry.route)).toEqual(expected);
    const stored = await env.dbs.app.selectFrom("tickets").select(["id", "route"]).execute();
    expect(new Map(stored.map((row) => [row.id, row.route]))).toEqual(
      new Map(ids.map((id, index) => [id, expected[index]])),
    );
    const toCanary = expected.filter((route) => route === "canary").length;
    expect(toCanary).toBeGreaterThanOrEqual(10);
    expect(FIRST_WAVE - toCanary).toBeGreaterThanOrEqual(10);

    // Every canary ticket was stopped by the reply guard and went to staff.
    // No customer was told about a refund that did not exist.
    outcomes.forEach((outcome, index) => {
      expect(outcome).toEqual(
        expected[index] === "canary"
          ? { outcome: "handed_to_staff", reasonCode: "guard_claims_refund_not_made" }
          : { outcome: "needs_clarification", reasonCode: "invoice_unclear" },
      );
    });
    expect(await env.dbs.app.selectFrom("alerts").selectAll().execute()).toEqual([]);
  }, 600_000);

  it("is rolled back by the watchdog, with an alert, and nobody had to act", async () => {
    await client.workflow.start("watchdogWorkflow", {
      args: [{ intervalSeconds: 1 }],
      taskQueue: queue("stable"),
      workflowId: `watchdog-${suffix}`,
    });

    const after = await eventually(rollout, (row) => row.canaryShare === 0, "the rollback");
    expect(after).toMatchObject({ canaryShare: 0, setBy: "system:watchdog" });

    const alerts = await eventually(
      () => env.dbs.app.selectFrom("alerts").selectAll().execute(),
      (rows) => rows.length > 0,
      "the alert",
    );
    const toCanary = routed.filter((entry) => entry.route === "canary").length;
    expect(alerts).toMatchObject([
      {
        kind: "rollback_canary",
        tenantId: null,
        raisedBy: "system:watchdog",
        detail: {
          canaryFinished: toCanary,
          canaryFailed: toCanary,
          stableFinished: FIRST_WAVE - toCanary,
          stableFailed: 0,
        },
      },
    ]);
    await eventually(
      async () => notified,
      (sent) => sent.length > 0,
      "the notification",
    );
    expect(notified).toEqual([{ kind: "rollback_canary", tenantId: null }]);
  }, 300_000);

  it("sends every later ticket to the stable build, which handles it properly", async () => {
    const before = routed.length;
    const ids: string[] = [];
    for (let index = 0; index < 12; index++) ids.push(await submit());
    const outcomes = await Promise.all(ids.map(finished));

    expect(routed.slice(before).every((entry) => entry.route === "stable")).toBe(true);
    // Half of these ids would have gone to the canary an hour ago.
    expect(ids.some((id) => routeFor(id, 50) === "canary")).toBe(true);
    expect(outcomes.every((outcome) => outcome.outcome === "needs_clarification")).toBe(true);
  }, 300_000);

  it("is rolled back once: the watchdog keeps running and stays quiet", async () => {
    // Several more rounds pass.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    expect(await env.dbs.app.selectFrom("alerts").selectAll().execute()).toHaveLength(1);
    expect(notified).toHaveLength(1);
    const entries = await env.dbs.app
      .selectFrom("auditLog")
      .select(["actor", "tenantId"])
      .where("event", "=", "canary_rolled_back")
      .execute();
    expect(entries).toEqual([{ actor: "system:watchdog", tenantId: "*" }]);
    expect(await verifyAudit(env.dbs.app)).toEqual([]);
    // The canary's failures were a reason to roll back, not to stop the agent.
    expect(await env.dbs.app.selectFrom("agentControls").selectAll().execute()).toEqual([]);
  }, 60_000);
});

describe("the stable build misreporting what it did", () => {
  it("gets the tenant's agent paused, with an alert", async () => {
    // Five of the stable build's tickets are marked as stopped by the reply
    // guard, as if its model had begun claiming refunds too.
    const stable = routed.filter((entry) => entry.route === "stable").slice(0, 5);
    await env.dbs.app
      .updateTable("tickets")
      .set({ outcome: "handed_to_staff", reasonCode: "guard_claims_refund_not_made" })
      .where(
        "id",
        "in",
        stable.map((entry) => entry.ticketId),
      )
      .execute();

    const controls = await eventually(
      () => env.dbs.app.selectFrom("agentControls").selectAll().execute(),
      (rows) => rows.length > 0,
      "the pause",
    );
    expect(controls).toMatchObject([
      { tenantId: tenant.id, scope: "agent", paused: true, setBy: "system:watchdog" },
    ]);
    await eventually(
      async () => notified,
      (sent) => sent.length > 1,
      "the second notification",
    );
    expect(notified[1]).toEqual({ kind: "pause_agent", tenantId: tenant.id });

    // The next ticket reaches a paused agent: no model call, straight to staff.
    expect(await finished(await submit())).toEqual({
      outcome: "handed_to_staff",
      reasonCode: "agent_paused",
    });
  }, 300_000);
});
