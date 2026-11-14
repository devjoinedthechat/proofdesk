import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createBillingApp, createBillingClient } from "@proofdesk/billing";
import {
  type AppDatabase,
  asRole,
  connect,
  DB_ROLES,
  TEST_ROLE_PASSWORD,
  testPostgresUrl,
} from "@proofdesk/db";
import {
  bearerToken,
  CLIENTS,
  connectKeycloakAdmin,
  createGrantSigner,
  createTokenClient,
  createTokenVerifier,
  createToolTokenSource,
  deleteRealm,
  generateGrantKey,
  type KeycloakAdmin,
  principalFrom,
  provisionCustomer,
  provisionRealm,
  realmIssuer,
  SCOPES,
  TokenError,
  type ToolTokenSource,
  testKeycloakUrl,
} from "@proofdesk/identity";
import { createPortalApp } from "@proofdesk/portal";
import { ServiceApiError } from "@proofdesk/service";
import {
  baseWorld,
  createSimEnv,
  loadWorld,
  ScenarioBuilder,
  type SimEnv,
  type TenantSlug,
} from "@proofdesk/simulator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBillingMcpApp } from "./app.ts";

// The whole authority chain against a real Keycloak and a real Postgres:
//
//   customer signs in → submits a ticket (this creates the grant)
//   worker → portal: "authority for ticket T, scope S"  → signed assertion
//   worker → Keycloak: assertion                        → 60-second token for the MCP server
//   worker → MCP server: tool call
//   MCP server → Keycloak: token exchange               → token for the billing service
//   MCP server → billing service → Postgres under row-level security

// biome-ignore lint/suspicious/noExplicitAny: tool and HTTP payloads in this test are untyped JSON
type Json = any;

const PASSWORD = "correct-horse-battery";
const realm = `test_${randomBytes(4).toString("hex")}`;
const issuer = realmIssuer(testKeycloakUrl(), realm);
const MCP_URL = "http://billing-mcp.test";

// Three customers on top of the background company, built together so their
// invoice numbers do not collide. Maya and Ines are customers of Harbor Notes;
// Tomas is a customer of Tallyfield. Maya was charged twice for one invoice.
const fixture = new ScenarioBuilder(baseWorld(), "authority-test");

function person(slug: TenantSlug, name: string, plan: string) {
  const customer = fixture.customer(slug, { name });
  const subscription = fixture.subscription(customer, { plan, seats: 3, startedDaysAgo: 40 });
  const earlier = fixture.invoice(subscription, { issuedDaysAgo: 35 });
  fixture.payment(earlier, { daysAgo: 35 });
  const invoice = fixture.invoice(subscription, { issuedDaysAgo: 5 });
  const payment = fixture.payment(invoice, { daysAgo: 5 });
  return { customer, invoice, payment };
}

const maya = person("harbor", "Maya Okafor", "team-monthly");
const mayaDuplicate = fixture.payment(maya.invoice, { daysAgo: 5, minutesLater: 2 });
const ines = person("harbor", "Ines Carvalho", "starter-monthly");
const tomas = person("tallyfield", "Tomas Brandt", "pro-monthly");
type Person = typeof maya;

let admin: KeycloakAdmin;
let env: SimEnv;
let portalDb: ReturnType<typeof connect<AppDatabase>>;
let grantsDb: ReturnType<typeof connect<AppDatabase>>;
let portal: ReturnType<typeof createPortalApp>;
let billingApp: ReturnType<typeof createBillingApp>;
let mcpApp: ReturnType<typeof createBillingMcpApp>;
let worker: ReturnType<typeof createTokenClient>;
let mcpTokens: ReturnType<typeof createTokenClient>;
let toolTokens: ToolTokenSource;
let now = new Date();

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
  if (!body.access_token) throw new Error(`Sign-in failed for ${email}: ${JSON.stringify(body)}`);
  return body.access_token;
}

async function portalCall(method: string, path: string, token: string | null, body?: unknown) {
  const response = await portal.fetch(
    new Request(`http://portal.test${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, Json> };
}

/** Signs in as the scenario's customer and submits a ticket, which creates the grant. */
async function submitTicket(who: Person, category = "refund"): Promise<string> {
  const token = await signIn(who.customer.email);
  const { status, body } = await portalCall("POST", "/tickets", token, {
    category,
    subject: "Question about my invoice",
    body: `Please look at invoice ${who.invoice.number}.`,
  });
  expect(status).toBe(201);
  return body.ticket.id as string;
}

async function connectMcp(token: string) {
  const client = new Client({ name: "authority-test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${MCP_URL}/mcp`), {
    fetch: (url, init) => Promise.resolve(mcpApp.fetch(new Request(url, init))),
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

async function callTool(token: string, name: string, args: Record<string, unknown> = {}) {
  const client = await connectMcp(token);
  try {
    const result = await client.callTool({ name, arguments: args });
    const [first] = result.content as { type: string; text: string }[];
    let payload: Json = first?.text;
    try {
      payload = JSON.parse(first?.text ?? "null");
    } catch {}
    return { isError: result.isError === true, payload };
  } finally {
    await client.close();
  }
}

const refundRows = () => env.dbs.billing.selectFrom("refunds").selectAll().execute();
const refundsBy = async (subjectPrefix: string) =>
  (await refundRows()).filter((row) => row.createdBy.startsWith(subjectPrefix));

async function tokenErrorOf(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(TokenError);
  return error as TokenError;
}

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

  env = await createSimEnv(testPostgresUrl());
  await loadWorld(fixture.added, env.dbs);
  for (const { customer } of [maya, ines, tomas]) {
    await provisionCustomer(
      admin,
      {
        id: customer.id,
        tenantId: customer.tenantId,
        email: customer.email,
        name: customer.name,
        password: PASSWORD,
      },
      realm,
    );
  }

  portalDb = connect<AppDatabase>(asRole(env.urls.app, DB_ROLES.portal, TEST_ROLE_PASSWORD));
  grantsDb = connect<AppDatabase>(asRole(env.urls.app, DB_ROLES.grants, TEST_ROLE_PASSWORD));
  let sequence = 0;
  const newId = (prefix: string) => `${prefix}_e2e${String(++sequence).padStart(4, "0")}`;

  portal = createPortalApp({
    // These tests file many tickets as one customer, with no agent handling them.
    limits: { ticketsPerHour: 1000, openTickets: 1000 },
    db: portalDb,
    grantsDb,
    verify: createTokenVerifier({ issuer, audience: CLIENTS.portal }),
    signer: await createGrantSigner({
      issuer: "https://grants.proofdesk.test",
      audience: issuer,
      key,
    }),
    clock: () => now,
    newId,
  });

  // The billing service, this time behind real token verification.
  const verifyBilling = createTokenVerifier({ issuer, audience: CLIENTS.billingApi });
  billingApp = createBillingApp({
    db: env.serviceDbs.billing,
    clock: () => now,
    newId,
    authenticate: async (request) => {
      const token = bearerToken(request);
      const verified = token ? await verifyBilling(token) : null;
      return verified ? principalFrom(verified, "agent") : null;
    },
  });

  mcpTokens = createTokenClient({
    issuer,
    clientId: CLIENTS.billingMcp,
    clientSecret: "mcp-secret",
  });
  mcpApp = createBillingMcpApp({
    verify: createTokenVerifier({ issuer, audience: CLIENTS.billingMcp }),
    tokens: mcpTokens,
    billingUrl: "http://billing.test",
    billingFetch: (request) => billingApp.fetch(request),
    resourceUrl: MCP_URL,
    issuer,
  });

  worker = createTokenClient({ issuer, clientId: CLIENTS.worker, clientSecret: "worker-secret" });
  toolTokens = createToolTokenSource({
    worker,
    portalUrl: "http://portal.test",
    portalFetch: (request) => portal.fetch(request),
  });
}, 120_000);

afterAll(async () => {
  await portalDb?.destroy();
  await grantsDb?.destroy();
  await env?.dispose();
  if (admin) await deleteRealm(admin, realm);
});

describe("the agent acts with the customer's authority", () => {
  it("reads the customer's own invoices through the MCP server", async () => {
    const ticketId = await submitTicket(maya);
    const { accessToken } = await toolTokens.forTool({ ticketId, scope: SCOPES.billingRead });

    const { isError, payload } = await callTool(accessToken, "list_invoices");

    expect(isError).toBe(false);
    const customers = new Set(payload.invoices.map((invoice: Json) => invoice.customerId));
    expect(customers).toEqual(new Set([maya.customer.id]));
    expect(payload.invoices).toHaveLength(2);
  });

  it("issues a token that is short-lived, single-audience and single-scope", async () => {
    const ticketId = await submitTicket(maya);
    const { accessToken } = await toolTokens.forTool({ ticketId, scope: SCOPES.billingRead });
    const claims = JSON.parse(Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString());

    expect(claims.aud).toBe(CLIENTS.billingMcp);
    expect(claims.scope).toBe(SCOPES.billingRead);
    expect(claims.azp).toBe(CLIENTS.worker);
    expect(claims.tenant_id).toBe(maya.customer.tenantId);
    expect(claims.customer_id).toBe(maya.customer.id);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(60);
  });

  it("refunds once, and a retry with the same key does not pay again", async () => {
    const ticketId = await submitTicket(maya);
    const refund = { paymentId: mayaDuplicate.id, amountCents: mayaDuplicate.amountCents };
    const args = {
      paymentId: refund.paymentId,
      amountCents: refund.amountCents,
      reason: "duplicate_charge",
      idempotencyKey: `${ticketId}:duplicate`,
    };

    const first = await callTool(
      (await toolTokens.forTool({ ticketId, scope: SCOPES.billingRefund })).accessToken,
      "create_refund",
      args,
    );
    const retry = await callTool(
      (await toolTokens.forTool({ ticketId, scope: SCOPES.billingRefund })).accessToken,
      "create_refund",
      args,
    );

    expect(first.isError).toBe(false);
    expect(retry.payload.refund.id).toBe(first.payload.refund.id);
    const rows = (await refundRows()).filter((row) => row.paymentId === refund.paymentId);
    expect(rows).toHaveLength(1);
    // The record names the service that acted and the customer it acted for.
    expect(rows[0]?.createdBy.startsWith(`${CLIENTS.billingMcp}:`)).toBe(true);
  });

  it("logs every assertion against its ticket", async () => {
    const ticketId = await submitTicket(ines);
    await toolTokens.forTool({ ticketId, scope: SCOPES.billingRead });
    await toolTokens.forTool({ ticketId, scope: SCOPES.billingRefund });

    const log = await env.dbs.app
      .selectFrom("grantAssertions")
      .select(["scope", "tenantId"])
      .where("ticketId", "=", ticketId)
      .orderBy("scope")
      .execute();
    expect(log).toEqual([
      { scope: SCOPES.billingRead, tenantId: ines.customer.tenantId },
      { scope: SCOPES.billingRefund, tenantId: ines.customer.tenantId },
    ]);
  });
});

describe("a token without the refund scope cannot refund", () => {
  let ticketId: string;
  let readToken: string;
  const attempt = () => ({
    paymentId: ines.payment.id,
    amountCents: 1_00,
    reason: "customer_request",
    idempotencyKey: "scope-test-0001",
  });

  beforeAll(async () => {
    ticketId = await submitTicket(ines);
    readToken = (await toolTokens.forTool({ ticketId, scope: SCOPES.billingRead })).accessToken;
  });

  it("is not shown the refund tool", async () => {
    const client = await connectMcp(readToken);
    const { tools } = await client.listTools();
    await client.close();
    expect(tools.map((tool) => tool.name).sort()).toEqual(["list_invoices", "list_subscriptions"]);
  });

  it("is refused when it calls the refund tool anyway", async () => {
    const result = await callTool(readToken, "create_refund", attempt()).catch((error: Error) => ({
      isError: true,
      payload: error.message,
    }));
    expect(result.isError).toBe(true);
    expect(
      await refundsBy(`${CLIENTS.billingMcp}:`).then((rows) =>
        rows.filter((row) => row.idempotencyKey === "scope-test-0001"),
      ),
    ).toEqual([]);
  });

  it("cannot be traded for a refund-scoped billing token, even by the MCP server", async () => {
    const error = await tokenErrorOf(
      mcpTokens.exchange(readToken, CLIENTS.billingApi, SCOPES.billingRefund),
    );
    expect(error.code).toBe("invalid_scope");
  });

  it("is refused by the billing service even with a valid read-only billing token", async () => {
    const { accessToken } = await mcpTokens.exchange(
      readToken,
      CLIENTS.billingApi,
      SCOPES.billingRead,
    );
    const billing = createBillingClient({
      baseUrl: "http://billing.test",
      fetch: (request) => billingApp.fetch(request),
      headers: () => ({ authorization: `Bearer ${accessToken}` }),
    });

    const { idempotencyKey, ...request } = attempt();
    const error = await billing
      .createRefund(request as Parameters<typeof billing.createRefund>[0], idempotencyKey)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ServiceApiError);
    expect(error).toMatchObject({ status: 403, code: "insufficient_scope" });
  });

  it("cannot be widened by the worker asking Keycloak for more than the assertion allows", async () => {
    const response = await portalCall(
      "POST",
      `/internal/tickets/${ticketId}/assertion`,
      (await worker.clientCredentials(SCOPES.grantsIssue)).accessToken,
      { scope: SCOPES.billingRead },
    );
    const error = await tokenErrorOf(
      worker.fromAssertion(
        response.body.assertion,
        `${SCOPES.billingRead} ${SCOPES.billingRefund}`,
      ),
    );
    expect(error.code).toBe("invalid_scope");
  });
});

describe("one customer's authority reaches nobody else", () => {
  it("cannot refund another customer's payment in the same tenant", async () => {
    const ticketId = await submitTicket(ines);
    const { accessToken } = await toolTokens.forTool({ ticketId, scope: SCOPES.billingRefund });
    const mayasPayment = maya.payment.id;

    const result = await callTool(accessToken, "create_refund", {
      paymentId: mayasPayment,
      amountCents: 1_00,
      reason: "customer_request",
      idempotencyKey: "cross-customer-0001",
    });

    expect(result.isError).toBe(true);
    expect(result.payload.error.code).toBe("payment_not_found");
  });

  it("cannot reach another tenant's payment", async () => {
    const ticketId = await submitTicket(tomas);
    const { accessToken } = await toolTokens.forTool({ ticketId, scope: SCOPES.billingRefund });

    const result = await callTool(accessToken, "create_refund", {
      paymentId: maya.payment.id,
      amountCents: 1_00,
      reason: "customer_request",
      idempotencyKey: "cross-tenant-0001",
    });
    const invoices = await callTool(
      (await toolTokens.forTool({ ticketId, scope: SCOPES.billingRead })).accessToken,
      "list_invoices",
      { invoiceNumber: maya.invoice.number },
    );

    expect(result.payload.error.code).toBe("payment_not_found");
    expect(
      invoices.payload.invoices.every((invoice: Json) => invoice.customerId === tomas.customer.id),
    ).toBe(true);
    const keys = (await refundRows()).map((row) => row.idempotencyKey);
    expect(keys).not.toContain("cross-tenant-0001");
    expect(keys).not.toContain("cross-customer-0001");
  });

  it("cannot be replayed against the billing service directly", async () => {
    const ticketId = await submitTicket(maya);
    const { accessToken } = await toolTokens.forTool({ ticketId, scope: SCOPES.billingRead });

    const response = await billingApp.fetch(
      new Request(`http://billing.test/customers/${maya.customer.id}/invoices`, {
        headers: { authorization: `Bearer ${accessToken}` },
      }),
    );
    // The token is addressed to the MCP server, so billing does not accept it.
    expect(response.status).toBe(401);
  });

  it("cannot be used by a customer to call agent tools with their own sign-in token", async () => {
    const token = await signIn(maya.customer.email);
    const response = await mcpApp.fetch(
      new Request(`${MCP_URL}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(response.status).toBe(401);
  });
});

describe("the grant is checked on every tool call", () => {
  const refusal = async (ticketId: string, scope: string) =>
    (await tokenErrorOf(toolTokens.forTool({ ticketId, scope }))).code;

  it("refuses a scope outside the ticket's category", async () => {
    const ticketId = await submitTicket(maya, "plan_change");
    expect(await refusal(ticketId, SCOPES.billingRefund)).toBe("scope_not_granted");
    await expect(toolTokens.forTool({ ticketId, scope: SCOPES.billingRead })).resolves.toBeTruthy();
  });

  it("refuses once the customer withdraws the grant", async () => {
    const ticketId = await submitTicket(maya);
    await toolTokens.forTool({ ticketId, scope: SCOPES.billingRead });

    const token = await signIn(maya.customer.email);
    const revoke = await portalCall("POST", `/tickets/${ticketId}/revoke-grant`, token);

    expect(revoke.status).toBe(200);
    expect(await refusal(ticketId, SCOPES.billingRead)).toBe("grant_revoked");
  });

  it("does not let one customer withdraw another customer's grant", async () => {
    const ticketId = await submitTicket(maya);
    const revoke = await portalCall(
      "POST",
      `/tickets/${ticketId}/revoke-grant`,
      await signIn(ines.customer.email),
    );
    expect(revoke.status).toBe(404);
    await expect(toolTokens.forTool({ ticketId, scope: SCOPES.billingRead })).resolves.toBeTruthy();
  });

  it("refuses once the ticket is closed or the grant has expired", async () => {
    const closed = await submitTicket(maya);
    await env.dbs.app
      .updateTable("tickets")
      .set({ status: "resolved" })
      .where("id", "=", closed)
      .execute();
    expect(await refusal(closed, SCOPES.billingRead)).toBe("ticket_closed");

    const old = await submitTicket(maya);
    const realNow = now;
    now = new Date(realNow.getTime() + 31 * 86_400_000);
    try {
      expect(await refusal(old, SCOPES.billingRead)).toBe("grant_expired");
    } finally {
      now = realNow;
    }
  });

  it("still works after the customer's own session is long gone", async () => {
    // Nothing from the sign-in is kept: the grant alone carries the authority.
    const ticketId = await submitTicket(maya);
    const realNow = now;
    now = new Date(realNow.getTime() + 10 * 86_400_000);
    try {
      const { accessToken } = await toolTokens.forTool({ ticketId, scope: SCOPES.billingRead });
      expect((await callTool(accessToken, "list_invoices")).isError).toBe(false);
    } finally {
      now = realNow;
    }
  });

  it("refuses an unknown ticket", async () => {
    expect(await refusal("tkt_does_not_exist", SCOPES.billingRead)).toBe("grant_not_found");
  });
});

describe("the worker cannot name a customer by itself", () => {
  it("has no way to get an assertion without its own credential", async () => {
    const ticketId = await submitTicket(maya);
    const path = `/internal/tickets/${ticketId}/assertion`;

    expect((await portalCall("POST", path, null, { scope: SCOPES.billingRead })).status).toBe(401);
    // A signed-in customer is not the worker.
    const customerToken = await signIn(maya.customer.email);
    expect(
      (await portalCall("POST", path, customerToken, { scope: SCOPES.billingRead })).status,
    ).toBe(403);
  });

  it("gets nothing from Keycloak for an assertion it signed itself", async () => {
    const forged = await createGrantSigner({
      issuer: "https://grants.proofdesk.test",
      audience: issuer,
      key: await generateGrantKey(),
    });
    const { assertion } = await forged.sign({
      customerId: maya.customer.id,
      scopes: [SCOPES.billingRefund],
    });

    const error = await tokenErrorOf(worker.fromAssertion(assertion, SCOPES.billingRefund));
    expect(error.code).toBe("invalid_grant");
  });

  it("cannot use one assertion twice", async () => {
    const ticketId = await submitTicket(maya);
    const { body } = await portalCall(
      "POST",
      `/internal/tickets/${ticketId}/assertion`,
      (await worker.clientCredentials(SCOPES.grantsIssue)).accessToken,
      { scope: SCOPES.billingRead },
    );

    await worker.fromAssertion(body.assertion, SCOPES.billingRead);
    const error = await tokenErrorOf(worker.fromAssertion(body.assertion, SCOPES.billingRead));
    expect(error.message).toMatch(/reuse/i);
  });

  it("cannot act for a customer with only its own service token", async () => {
    const { accessToken } = await worker.clientCredentials(SCOPES.grantsIssue);
    const response = await mcpApp.fetch(
      new Request(`${MCP_URL}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(response.status).toBe(401);
  });
});

describe("the MCP server as a protected resource", () => {
  it("answers an unauthenticated request with 401 and where to get a token", async () => {
    const response = await mcpApp.fetch(
      new Request(`${MCP_URL}/mcp`, { method: "POST", body: "{}" }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${MCP_URL}/.well-known/oauth-protected-resource"`,
    );

    const metadata = await mcpApp.fetch(
      new Request(`${MCP_URL}/.well-known/oauth-protected-resource`),
    );
    expect(await metadata.json()).toMatchObject({
      resource: MCP_URL,
      authorization_servers: [issuer],
    });
  });

  it("rejects a token that was tampered with", async () => {
    const ticketId = await submitTicket(maya);
    const { accessToken } = await toolTokens.forTool({ ticketId, scope: SCOPES.billingRead });
    const [header, payload, signature] = accessToken.split(".");
    const claims = JSON.parse(Buffer.from(payload ?? "", "base64url").toString());
    claims.customer_id = ines.customer.id;
    const tampered = [
      header,
      Buffer.from(JSON.stringify(claims)).toString("base64url"),
      signature,
    ].join(".");

    const response = await mcpApp.fetch(
      new Request(`${MCP_URL}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${tampered}` },
        body: "{}",
      }),
    );
    expect(response.status).toBe(401);
  });
});

describe("ticket submission", () => {
  it("lets a customer see only their own tickets", async () => {
    await submitTicket(tomas);
    const mine = await portalCall("GET", "/tickets", await signIn(tomas.customer.email));
    const theirs = await portalCall("GET", "/tickets", await signIn(ines.customer.email));

    expect(mine.body.tickets.length).toBeGreaterThan(0);
    const all = await env.dbs.app.selectFrom("tickets").select(["id", "customerId"]).execute();
    const owner = new Map(all.map((row) => [row.id, row.customerId]));
    for (const ticket of mine.body.tickets) expect(owner.get(ticket.id)).toBe(tomas.customer.id);
    for (const ticket of theirs.body.tickets) expect(owner.get(ticket.id)).toBe(ines.customer.id);
  });

  it("requires sign-in and a valid ticket", async () => {
    const body = { category: "refund", subject: "s", body: "b" };
    expect((await portalCall("POST", "/tickets", null, body)).status).toBe(401);

    const token = await signIn(maya.customer.email);
    expect(
      (await portalCall("POST", "/tickets", token, { ...body, category: "free_money" })).status,
    ).toBe(400);
    expect(
      (await portalCall("POST", "/tickets", token, { ...body, tenantId: "ten_tallyfield" })).status,
    ).toBe(400);
  });
});
