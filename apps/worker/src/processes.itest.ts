import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { asRole, DB_ROLES, TEST_ROLE_PASSWORD, testPostgresUrl, verifyAudit } from "@proofdesk/db";
import {
  CLIENTS,
  connectKeycloakAdmin,
  deleteRealm,
  generateGrantKey,
  type KeycloakAdmin,
  provisionCustomer,
  provisionRealm,
  provisionStaff,
  realmIssuer,
  testKeycloakUrl,
} from "@proofdesk/identity";
import { type Served, serve } from "@proofdesk/service";
import {
  baseWorld,
  createSimEnv,
  diffSnapshots,
  loadWorld,
  materialise,
  REFUND_SCENARIOS,
  type Scenario,
  type SimEnv,
  takeSnapshot,
} from "@proofdesk/simulator";
import { Client, Connection } from "@temporalio/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { testTemporalAddress } from "./testing.ts";

// Everything as real processes: the billing service, the billing MCP server,
// the portal and the worker each run as their own Node process and talk over
// HTTP, against real Keycloak, Postgres and Temporal. Only the model is a
// stand-in. This is where a worker process is actually killed.

const PASSWORD = "simulation-only-password";
const GRANT_ISSUER = "https://grants.proofdesk.test";
const entry = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));

const scenario = (id: string): Scenario => {
  const spec = REFUND_SCENARIOS.find((candidate) => candidate.id === id);
  if (!spec) throw new Error(`No scenario ${id}`);
  return materialise(spec, baseWorld());
};

type Running = { child: ChildProcess; url: string; output: () => string };

/** Starts a process and waits until it prints the line that says it is ready. */
function launch(script: string, env: Record<string, string>, ready: RegExp): Promise<Running> {
  const child = spawn(process.execPath, [entry(script)], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${script} did not start:\n${output}`)),
      60_000,
    );
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const match = ready.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve({ child, url: match[1] ?? "", output: () => output });
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`${script} exited with ${code} before it was ready:\n${output}`));
    });
  });
}

function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGKILL");
  });
}

let admin: KeycloakAdmin;
let client: Client;
let connection: Connection;
const realm = `proc_${randomBytes(4).toString("hex")}`;
const issuer = realmIssuer(testKeycloakUrl(), realm);
let grantKeyJson = "";

type Stack = Awaited<ReturnType<typeof startStack>>;
let stack: Stack | undefined;

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

/** One company with one scenario loaded, and the four services running as processes on top of it. */
async function startStack(target: Scenario) {
  const env: SimEnv = await createSimEnv(testPostgresUrl());
  await loadWorld({ ...target.added, tickets: [] }, env.dbs);
  const before = await takeSnapshot(env.dbs);
  await provisionCustomer(
    admin,
    {
      id: target.customer.id,
      tenantId: target.customer.tenantId,
      email: target.customer.email,
      name: target.customer.name,
      password: PASSWORD,
    },
    realm,
  ).catch((error: Error) => {
    // The same scenario customer may already exist from an earlier test.
    if (!error.message.includes("409")) throw error;
  });

  const children: ChildProcess[] = [];
  const listening = /listening on (http:\/\/\S+)/;
  const taskQueue = `proc-${randomBytes(4).toString("hex")}`;
  const temporal = {
    TEMPORAL_ADDRESS: testTemporalAddress(),
    TEMPORAL_NAMESPACE: "default",
    TEMPORAL_TASK_QUEUE: taskQueue,
  };
  const role = (url: string, name: string) => asRole(url, name, TEST_ROLE_PASSWORD);

  const billing = await launch(
    "services/billing/src/main.ts",
    {
      PORT: "0",
      KEYCLOAK_ISSUER: issuer,
      BILLING_DATABASE_URL: role(env.urls.billing, DB_ROLES.billing),
    },
    listening,
  );
  children.push(billing.child);

  // A relay between the MCP server and billing, so the test can see refund
  // requests and act at the exact moment billing has answered one.
  const refundResponses: number[] = [];
  let afterRefund: (() => Promise<void>) | undefined;
  const relay: Served = await serve(
    {
      async fetch(request) {
        const url = new URL(request.url);
        const body = request.method === "GET" ? undefined : await request.arrayBuffer();
        const response = await fetch(`${billing.url}${url.pathname}${url.search}`, {
          method: request.method,
          headers: request.headers,
          ...(body ? { body } : {}),
        });
        const payload = await response.arrayBuffer();
        if (request.method === "POST" && url.pathname === "/refunds") {
          refundResponses.push(response.status);
          const hook = afterRefund;
          afterRefund = undefined;
          await hook?.();
        }
        return new Response(payload, {
          status: response.status,
          headers: { "content-type": "application/json" },
        });
      },
    },
    { port: 0 },
  );

  const mcp = await launch(
    "mcp/billing/src/main.ts",
    {
      PORT: "0",
      KEYCLOAK_ISSUER: issuer,
      BILLING_MCP_CLIENT_SECRET: "mcp-secret",
      BILLING_URL: relay.url,
      PUBLIC_URL: "http://billing-mcp.local",
    },
    listening,
  );
  children.push(mcp.child);

  const portal = await launch(
    "apps/portal/src/main.ts",
    {
      PORT: "0",
      KEYCLOAK_ISSUER: issuer,
      GRANT_ISSUER,
      GRANT_KEY_JSON: grantKeyJson,
      PORTAL_DATABASE_URL: role(env.urls.app, DB_ROLES.portal),
      GRANTS_DATABASE_URL: role(env.urls.app, DB_ROLES.grants),
      ...temporal,
    },
    listening,
  );
  children.push(portal.child);

  const startWorker = async () => {
    const worker = await launch(
      "apps/worker/src/main.ts",
      {
        KEYCLOAK_ISSUER: issuer,
        WORKER_CLIENT_SECRET: "worker-secret",
        WORKER_DATABASE_URL: role(env.urls.app, DB_ROLES.worker),
        PORTAL_URL: portal.url,
        BILLING_MCP_URL: `${mcp.url}/mcp`,
        MODEL: "rule-model",
        MODEL_PROVIDER_MODULE: entry("apps/worker/src/testing/duplicate-refund-model.ts"),
        ...temporal,
      },
      /(worker started)/,
    );
    children.push(worker.child);
    return worker;
  };

  const portalCall = async (method: string, path: string, token: string, body?: unknown) => {
    const response = await fetch(`${portal.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    // biome-ignore lint/suspicious/noExplicitAny: untyped JSON from the portal
    return { status: response.status, body: (await response.json()) as any };
  };

  return {
    env,
    startWorker,
    portalCall,
    refundResponses,
    onNextRefund(hook: () => Promise<void>) {
      afterRefund = hook;
    },
    async submitTicket() {
      const token = await signIn(target.customer.email);
      const { status, body } = await portalCall("POST", "/tickets", token, {
        category: "refund",
        subject: target.ticket.subject,
        body: target.ticket.body,
      });
      expect(status).toBe(201);
      const ticketId = body.ticket.id as string;
      return { ticketId, handle: client.workflow.getHandle(`ticket-${ticketId}`), token };
    },
    async refunds() {
      return diffSnapshots(before, await takeSnapshot(env.dbs))
        .filter((change) => change.table === "billing.refunds" && change.kind === "added")
        .map((change) => ({
          paymentId: change.row.paymentId,
          amountCents: change.row.amountCents,
        }));
    },
    async dispose() {
      await Promise.all(children.map(stop));
      await relay.close();
      await env.dispose();
    },
  };
}

async function waitFor<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  label: string,
): Promise<T> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

beforeAll(async () => {
  admin = await connectKeycloakAdmin({
    url: testKeycloakUrl(),
    username: "admin",
    password: "admin",
  });
  const key = await generateGrantKey();
  grantKeyJson = JSON.stringify(key);
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
  for (const [tenantId, email] of [
    ["ten_tallyfield", "approver@tallyfield.example"],
    ["ten_harbor", "approver@harbor.example"],
  ] as const) {
    await provisionStaff(
      admin,
      { tenantId, email, name: "Ada Approver", role: "approver", password: PASSWORD },
      realm,
    );
  }
  connection = await Connection.connect({ address: testTemporalAddress() });
  client = new Client({ connection, namespace: "default" });
}, 120_000);

afterEach(async () => {
  await stack?.dispose();
  stack = undefined;
});

afterAll(async () => {
  await connection?.close();
  if (admin) await deleteRealm(admin, realm);
});

describe("the system as separate processes", () => {
  it("issues exactly one refund when the worker process is killed mid-refund", async () => {
    const target = scenario("refund-duplicate-with-invoice");
    stack = await startStack(target);
    const first = await stack.startWorker();

    // The moment billing has paid, and before the worker can hear about it,
    // the worker process is killed outright.
    let killed = false;
    stack.onNextRefund(async () => {
      await stop(first.child);
      killed = true;
    });

    const { ticketId, handle } = await stack.submitTicket();
    await waitFor(async () => killed, Boolean, "the worker to be killed");
    expect(first.child.signalCode).toBe("SIGKILL");
    expect(await stack.refunds()).toEqual(target.expected.refunds);

    // A second worker starts. The engine notices the first one went silent
    // and gives the unfinished step to the new one.
    await stack.startWorker();
    const outcome = await handle.result();

    expect(outcome).toEqual({ outcome: "refunded", reasonCode: "duplicate_charge" });
    // Billing was asked to refund twice and paid once: created, then replayed.
    expect(stack.refundResponses).toEqual([201, 200]);
    expect(await stack.refunds()).toEqual(target.expected.refunds);

    const ticket = await stack.env.dbs.app
      .selectFrom("tickets")
      .selectAll()
      .where("id", "=", ticketId)
      .executeTakeFirstOrThrow();
    expect(ticket).toMatchObject({ status: "resolved", outcome: "refunded" });
    expect(ticket.reply).toContain("$87.00");

    const audit = await stack.env.dbs.app
      .selectFrom("auditLog")
      .select(["event", "detail"])
      .orderBy("seq")
      .execute();
    expect(
      audit.filter((row) => row.event === "tool_call" && row.detail.includes("create_refund")),
    ).toHaveLength(1);
    expect(await verifyAudit(stack.env.dbs.app)).toEqual([]);
  }, 180_000);

  it("pays a large refund only after staff of that tenant approve it through the portal", async () => {
    const target = scenario("refund-duplicate-over-limit");
    stack = await startStack(target);
    await stack.startWorker();
    const { ticketId, handle } = await stack.submitTicket();

    const ownStaff = await signIn("approver@tallyfield.example");
    const otherStaff = await signIn("approver@harbor.example");
    const pending = await waitFor(
      () => stack?.portalCall("GET", "/staff/approvals", ownStaff) ?? Promise.reject(),
      (result) => result.body.approvals?.length === 1,
      "the approval request",
    );
    const [approval] = pending.body.approvals;
    expect(approval).toMatchObject({
      ticketId,
      tool: "create_refund",
      summary: { amountCents: 980_00 },
    });
    expect(await stack.refunds()).toEqual([]);

    // Staff of another company cannot see or decide it, and neither can the customer.
    const decide = (token: string) =>
      stack?.portalCall(
        "POST",
        `/staff/approvals/${encodeURIComponent(approval.id)}/decision`,
        token,
        {
          decision: "approved",
        },
      );
    expect((await stack.portalCall("GET", "/staff/approvals", otherStaff)).body.approvals).toEqual(
      [],
    );
    expect((await decide(otherStaff))?.status).toBe(404);
    expect((await decide(await signIn(target.customer.email)))?.status).toBe(403);
    expect(await stack.refunds()).toEqual([]);

    expect((await decide(ownStaff))?.status).toBe(202);
    expect(await handle.result()).toEqual({ outcome: "refunded", reasonCode: "duplicate_charge" });
    expect(await stack.refunds()).toEqual(target.expected.refunds);

    const decided = await stack.env.dbs.app
      .selectFrom("approvals")
      .select(["status", "decidedBy"])
      .executeTakeFirstOrThrow();
    expect(decided.status).toBe("approved");
    expect(decided.decidedBy).toMatch(/^staff:/);
    expect((await decide(ownStaff))?.status).toBe(409);
  }, 180_000);
});
