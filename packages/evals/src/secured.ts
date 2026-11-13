import { randomBytes } from "node:crypto";
import { type AgentTool, discoverMcpTools } from "@proofdesk/agent";
import { createBillingApp } from "@proofdesk/billing";
import { type AppDatabase, asRole, connect, DB_ROLES, TEST_ROLE_PASSWORD } from "@proofdesk/db";
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
  principalFrom,
  provisionCustomer,
  provisionRealm,
  realmIssuer,
  SCOPES,
  TokenError,
} from "@proofdesk/identity";
import { createBillingMcpApp } from "@proofdesk/mcp-billing";
import { createPortalApp } from "@proofdesk/portal";
import {
  createSimEnv,
  runScenario,
  type Scenario,
  type ScenarioResult,
  type Solver,
  type SolverContext,
} from "@proofdesk/simulator";

const PASSWORD = "simulation-only-password";
const GRANT_ISSUER = "https://grants.proofdesk.test";
const MCP_URL = "http://billing-mcp.sim/mcp";

export type SecuredHarness = Awaited<ReturnType<typeof createSecuredHarness>>;

/**
 * Runs scenarios the way production runs tickets. The customer signs in at a
 * real Keycloak and submits the ticket through the portal, which creates the
 * grant. The solver gets its tools from the billing MCP server, with a fresh
 * single-scope token per call. Nothing asserts an identity in a header.
 *
 * One realm serves all scenarios of a harness; each scenario gets its own
 * databases and its own Keycloak user.
 */
export async function createSecuredHarness(options: { postgresUrl: string; keycloakUrl: string }) {
  const realm = `sim_${randomBytes(4).toString("hex")}`;
  const issuer = realmIssuer(options.keycloakUrl, realm);
  const admin = await connectKeycloakAdmin({
    url: options.keycloakUrl,
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
  const signer = await createGrantSigner({ issuer: GRANT_ISSUER, audience: issuer, key });
  const verifyBilling = createTokenVerifier({ issuer, audience: CLIENTS.billingApi });
  const verifyMcp = createTokenVerifier({ issuer, audience: CLIENTS.billingMcp });
  const verifyPortal = createTokenVerifier({ issuer, audience: CLIENTS.portal });
  const worker = createTokenClient({
    issuer,
    clientId: CLIENTS.worker,
    clientSecret: "worker-secret",
  });
  const mcpTokens = createTokenClient({
    issuer,
    clientId: CLIENTS.billingMcp,
    clientSecret: "mcp-secret",
  });

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

  return {
    realm,

    /**
     * Runs one scenario. `solverFor` receives a function that builds the
     * agent's tools from the MCP server for the ticket at hand.
     */
    async run(
      scenario: Scenario,
      solverFor: (tools: (context: SolverContext) => Promise<AgentTool[]>) => Solver,
    ): Promise<ScenarioResult & { ticketId: string; assertions: { scope: string }[] }> {
      const env = await createSimEnv(options.postgresUrl);
      const portalDb = connect<AppDatabase>(
        asRole(env.urls.app, DB_ROLES.portal, TEST_ROLE_PASSWORD),
      );
      const grantsDb = connect<AppDatabase>(
        asRole(env.urls.app, DB_ROLES.grants, TEST_ROLE_PASSWORD),
      );
      let sequence = 0;
      const newId = (prefix: string) => `${prefix}_sec${String(++sequence).padStart(5, "0")}`;
      const clock = () => env.now;

      try {
        const portal = createPortalApp({
          db: portalDb,
          grantsDb,
          verify: verifyPortal,
          signer,
          clock,
          newId,
        });
        const billingApp = createBillingApp({
          db: env.serviceDbs.billing,
          clock,
          newId,
          authenticate: async (request) => {
            const token = bearerToken(request);
            const verified = token ? await verifyBilling(token) : null;
            return verified ? principalFrom(verified, "agent") : null;
          },
        });
        const mcpApp = createBillingMcpApp({
          verify: verifyMcp,
          tokens: mcpTokens,
          billingUrl: "http://billing.sim",
          billingFetch: (request) => billingApp.fetch(request),
          resourceUrl: "http://billing-mcp.sim",
          issuer,
        });
        const toolTokens = createToolTokenSource({
          worker,
          portalUrl: "http://portal.sim",
          portalFetch: (request) => portal.fetch(request),
        });

        let ticketId = "";
        const tools = (context: SolverContext) =>
          discoverMcpTools({
            url: MCP_URL,
            scopes: [SCOPES.billingRead, SCOPES.billingRefund],
            fetch: (request) => mcpApp.fetch(request),
            async tokenFor(scope) {
              try {
                return (await toolTokens.forTool({ ticketId: context.ticket.id, scope }))
                  .accessToken;
              } catch (error) {
                if (error instanceof TokenError) return null;
                throw error;
              }
            },
          });

        const result = await runScenario(env, scenario, solverFor(tools), {
          async prepare() {
            const { customer, ticket } = scenario;
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
            const response = await portal.fetch(
              new Request("http://portal.sim/tickets", {
                method: "POST",
                headers: {
                  authorization: `Bearer ${await signIn(customer.email)}`,
                  "content-type": "application/json",
                },
                body: JSON.stringify({
                  category: ticket.category,
                  subject: ticket.subject,
                  body: ticket.body,
                }),
              }),
            );
            const body = (await response.json()) as { ticket?: { id: string } };
            if (!body.ticket)
              throw new Error(`Ticket submission failed with status ${response.status}`);
            ticketId = body.ticket.id;
            return { ticket: { ...ticket, id: ticketId } };
          },
        });

        const assertions = await env.dbs.app
          .selectFrom("grantAssertions")
          .select("scope")
          .where("ticketId", "=", ticketId)
          .orderBy("issuedAt")
          .execute();
        return { ...result, ticketId, assertions };
      } finally {
        await portalDb.destroy();
        await grantsDb.destroy();
        await env.dispose();
      }
    },

    async dispose() {
      await deleteRealm(admin, realm);
    },
  };
}
