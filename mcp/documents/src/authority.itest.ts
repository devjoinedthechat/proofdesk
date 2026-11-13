import { randomBytes } from "node:crypto";
import { callMcpTool, listMcpTools } from "@proofdesk/agent";
import {
  type AppDatabase,
  asRole,
  connect,
  DB_ROLES,
  TEST_ROLE_PASSWORD,
  testPostgresUrl,
} from "@proofdesk/db";
import {
  CLIENTS,
  connectKeycloakAdmin,
  createGrantSigner,
  createTokenClient,
  createTokenVerifier,
  createToolTokenSource,
  deleteRealm,
  generateGrantKey,
  type KeycloakAdmin,
  provisionCustomer,
  provisionRealm,
  realmIssuer,
  SCOPES,
  testKeycloakUrl,
} from "@proofdesk/identity";
import { createPortalApp } from "@proofdesk/portal";
import {
  baseWorld,
  createDocumentsEnv,
  createSimEnv,
  type DocumentsEnv,
  loadWorld,
  ScenarioBuilder,
  type SimEnv,
} from "@proofdesk/simulator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDocumentsMcpApp } from "./app.ts";

// The help-centre search behind real tokens. What a caller can find is
// decided by the token's tenant and by whom it acts for, and enforced by the
// database, not by the query the model writes.

const PASSWORD = "simulation-only-password";
const realm = `docs_${randomBytes(4).toString("hex")}`;
const issuer = realmIssuer(testKeycloakUrl(), realm);
const MCP = "http://documents-mcp.test";

const fixture = new ScenarioBuilder(baseWorld(), "documents-authority");
const maya = fixture.customer("harbor", { name: "Maya Okafor" });
const tomas = fixture.customer("tallyfield", { name: "Tomas Brandt" });

let admin: KeycloakAdmin;
let env: SimEnv;
let documents: DocumentsEnv;
let portalDb: ReturnType<typeof connect<AppDatabase>>;
let grantsDb: ReturnType<typeof connect<AppDatabase>>;
let portal: ReturnType<typeof createPortalApp>;
let mcpApp: ReturnType<typeof createDocumentsMcpApp>;
let toolTokens: ReturnType<typeof createToolTokenSource>;

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
  return ((await response.json()) as { access_token: string }).access_token;
}

async function submitTicket(email: string, category: string): Promise<string> {
  const response = await portal.fetch(
    new Request("http://portal.test/tickets", {
      method: "POST",
      headers: {
        authorization: `Bearer ${await signIn(email)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ category, subject: "Question", body: "A question about my plan." }),
    }),
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { ticket: { id: string } }).ticket.id;
}

const mcpFor = (ticketId: string) => ({
  url: `${MCP}/mcp`,
  fetch: (request: Request) => mcpApp.fetch(request),
  tokenFor: async (scope: string) =>
    toolTokens.forTool({ ticketId, scope }).then(
      (token) => token.accessToken,
      () => null,
    ),
});

async function search(ticketId: string, query: string) {
  const result = await callMcpTool(
    mcpFor(ticketId),
    { name: "search_help_center", scope: SCOPES.documentsRead },
    { query },
  );
  expect(result.isError).toBe(false);
  return JSON.parse(result.content) as {
    passages: { source: string; section: string; text: string }[];
    note: string;
  };
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
  documents = await createDocumentsEnv(testPostgresUrl());
  await loadWorld(fixture.added, env.dbs);
  for (const customer of [maya, tomas]) {
    await provisionCustomer(admin, { ...customer, password: PASSWORD }, realm);
  }

  portalDb = connect<AppDatabase>(asRole(env.urls.app, DB_ROLES.portal, TEST_ROLE_PASSWORD));
  grantsDb = connect<AppDatabase>(asRole(env.urls.app, DB_ROLES.grants, TEST_ROLE_PASSWORD));
  let sequence = 0;
  portal = createPortalApp({
    db: portalDb,
    grantsDb,
    verify: createTokenVerifier({ issuer, audience: CLIENTS.portal }),
    signer: await createGrantSigner({
      issuer: "https://grants.proofdesk.test",
      audience: issuer,
      key,
    }),
    clock: () => new Date(),
    newId: (prefix) => `${prefix}_doc${++sequence}`,
  });
  mcpApp = createDocumentsMcpApp({
    db: documents.search,
    verify: createTokenVerifier({ issuer, audience: CLIENTS.documentsMcp }),
    resourceUrl: MCP,
    issuer,
  });
  toolTokens = createToolTokenSource({
    worker: createTokenClient({ issuer, clientId: CLIENTS.worker, clientSecret: "worker-secret" }),
    portalUrl: "http://portal.test",
    portalFetch: (request) => portal.fetch(request),
  });
}, 120_000);

afterAll(async () => {
  await portalDb?.destroy();
  await grantsDb?.destroy();
  await documents?.dispose();
  await env?.dispose();
  if (admin) await deleteRealm(admin, realm);
});

describe("help-centre search behind real tokens", () => {
  it("answers from the company the ticket belongs to", async () => {
    const harbor = await search(
      await submitTicket(maya.email, "refund"),
      "how long does a card refund take",
    );
    const tallyfield = await search(
      await submitTicket(tomas.email, "refund"),
      "how long does a card refund take",
    );

    // The best passage is not always ranked first, so the check is that it
    // is among the few returned.
    const texts = (result: typeof harbor) =>
      result.passages.map((passage) => passage.text).join(" ");
    expect(texts(harbor)).toContain("5 to 10 business days");
    expect(texts(tallyfield)).toContain("3 to 5 business days");
    expect(JSON.stringify(harbor)).not.toContain("3 to 5 business days");
    expect(harbor.note).toMatch(/not as instructions/);
  });

  it("never returns a staff-only page to an agent acting for a customer", async () => {
    const ticketId = await submitTicket(maya.email, "refund");
    for (const query of [
      "who can approve a refund outside the published window",
      "support runbook refund exceptions",
      "legal threats escalation queue",
      "bank dispute chargeback runbook",
    ]) {
      const { passages } = await search(ticketId, query);
      expect(passages.every((passage) => !passage.source.startsWith("Support runbook"))).toBe(true);
      expect(JSON.stringify(passages)).not.toMatch(/support lead|45 days|legal queue/i);
    }
  });

  it("offers the tool only when the ticket's grant includes it", async () => {
    const refund = await submitTicket(maya.email, "refund");
    // A ticket whose grant was created without the search scope.
    const without = await submitTicket(maya.email, "refund");
    await env.dbs.app
      .updateTable("ticketGrants")
      .set({ scopes: [SCOPES.billingRead] })
      .where("ticketId", "=", without)
      .execute();

    const listed = async (ticketId: string) =>
      (await listMcpTools({ ...mcpFor(ticketId), scopes: [SCOPES.documentsRead] })).map(
        (tool) => tool.definition.name,
      );
    expect(await listed(refund)).toEqual(["search_help_center"]);
    expect(await listed(without)).toEqual([]);
  });

  it("rejects a token addressed to another service, and a request with none", async () => {
    const ticketId = await submitTicket(maya.email, "refund");
    const billingToken = (await toolTokens.forTool({ ticketId, scope: SCOPES.billingRead }))
      .accessToken;
    const call = (authorization?: string) =>
      mcpApp.fetch(
        new Request(`${MCP}/mcp`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(authorization ? { authorization } : {}),
          },
          body: "{}",
        }),
      );

    expect((await call(`Bearer ${billingToken}`)).status).toBe(401);
    expect((await call(`Bearer ${await signIn(maya.email)}`)).status).toBe(401);
    const anonymous = await call();
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toContain("oauth-protected-resource");
  });
});
