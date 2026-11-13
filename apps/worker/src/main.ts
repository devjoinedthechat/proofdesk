import { pathToFileURL } from "node:url";
import { callMcpTool, listMcpTools, screenTicket } from "@proofdesk/agent";
import { type AppDatabase, connect } from "@proofdesk/db";
import {
  ANTHROPIC_PRICES,
  CLAUDE_FAILOVER,
  createAnthropicProvider,
  createGateway,
  type GatewayRoute,
  type ModelProvider,
  type PriceTable,
} from "@proofdesk/gateway";
import {
  CLIENTS,
  connectKeycloakAdmin,
  createTokenClient,
  createToolTokenSource,
  deleteCustomerAccount,
  SCOPES,
  TokenError,
} from "@proofdesk/identity";
import { createToolPolicy, invoiceRecords } from "@proofdesk/policy";
import { env } from "@proofdesk/service";
import { NativeConnection } from "@temporalio/worker";
import { createActivities, type TicketRef } from "./activities.ts";
import { createDeletionActivities, mcpErasers } from "./deletion.ts";
import { createDbLedger } from "./ledger.ts";
import { createTicketWorker } from "./worker.ts";

/**
 * The model routes. By default this is Anthropic. MODEL_PROVIDER_MODULE can
 * name a module that exports another provider and its prices, which is how a
 * second provider is plugged in and how tests run without a model.
 */
async function loadProvider(): Promise<{
  routes: [GatewayRoute, ...GatewayRoute[]];
  prices: PriceTable;
}> {
  const path = process.env.MODEL_PROVIDER_MODULE;
  if (!path) {
    const provider = createAnthropicProvider();
    // When one Claude model stays overloaded or rate-limited, the turn goes
    // to another. This does not help if the API itself cannot be reached.
    return {
      routes: [{ provider }, { provider, models: CLAUDE_FAILOVER }],
      prices: ANTHROPIC_PRICES,
    };
  }
  const module = (await import(pathToFileURL(path).href)) as {
    default: ModelProvider;
    prices: PriceTable;
  };
  return { routes: [{ provider: module.default }], prices: module.prices };
}

async function start() {
  const db = connect<AppDatabase>(env("WORKER_DATABASE_URL"));
  const { routes, prices } = await loadProvider();
  const gateway = createGateway({
    routes,
    prices,
    ledger: createDbLedger(db),
    limits: {
      perTicketMicros: Number(process.env.BUDGET_PER_TICKET_MICROS ?? 500_000),
      perTenantMicros: Number(process.env.BUDGET_PER_TENANT_MICROS ?? 50_000_000),
    },
  });

  const toolTokens = createToolTokenSource({
    worker: createTokenClient({
      issuer: env("KEYCLOAK_ISSUER"),
      clientId: CLIENTS.worker,
      clientSecret: env("WORKER_CLIENT_SECRET"),
    }),
    portalUrl: env("PORTAL_URL"),
  });
  const tokenFor = (ref: TicketRef) => async (scope: string) => {
    try {
      return (await toolTokens.forTool({ ticketId: ref.ticketId, scope })).accessToken;
    } catch (error) {
      // The grant does not cover this scope, or no longer holds.
      if (error instanceof TokenError) return null;
      throw error;
    }
  };
  // The MCP servers the agent may use, and the scopes to try on each.
  const servers = [
    {
      url: env("BILLING_MCP_URL"),
      scopes: [SCOPES.billingRead, SCOPES.billingRefund, SCOPES.billingPlan],
    },
    ...(process.env.ENTITLEMENTS_MCP_URL
      ? [
          {
            url: process.env.ENTITLEMENTS_MCP_URL,
            scopes: [SCOPES.entitlementsRead, SCOPES.entitlementsWrite],
          },
        ]
      : []),
    ...(process.env.DOCUMENTS_MCP_URL
      ? [{ url: process.env.DOCUMENTS_MCP_URL, scopes: [SCOPES.documentsRead] }]
      : []),
  ];

  const screenModel = process.env.SCREEN_MODEL;
  const activities = createActivities({
    db,
    gateway,
    versions: {
      model: env("MODEL"),
      prompt: process.env.PROMPT_VERSION ?? "dev",
      policy: process.env.POLICY_VERSION ?? "dev",
    },
    policy: createToolPolicy(),
    clock: () => new Date(),
    ...(screenModel
      ? {
          screen: (ref: TicketRef, ticket: { subject: string; body: string }) =>
            screenTicket({
              gateway,
              model: screenModel,
              context: { tenantId: ref.tenantId, ticketId: ref.ticketId },
              ...ticket,
            }),
        }
      : {}),
    // The policy layer reads the customer's invoices through the same
    // token-scoped path as the agent, with its own fresh read token.
    async invoices(ref) {
      const result = await callMcpTool(
        { url: env("BILLING_MCP_URL"), tokenFor: tokenFor(ref) },
        { name: "list_invoices", scope: SCOPES.billingRead },
        {},
      );
      if (result.isError) throw new Error(`Could not read invoices for policy: ${result.content}`);
      return invoiceRecords.parse((JSON.parse(result.content) as { invoices?: unknown }).invoices);
    },
    tools: {
      async list(ref) {
        const found = await Promise.all(
          servers.map((server) => listMcpTools({ ...server, tokenFor: tokenFor(ref) })),
        );
        return found.flat();
      },
      call: (ref, tool, input) =>
        callMcpTool(
          { url: tool.endpoint, tokenFor: tokenFor(ref) },
          { name: tool.definition.name, scope: tool.scope },
          input,
        ),
    },
  });

  // Deletion needs the entitlements server and a Keycloak account that may
  // delete users. A worker without them handles tickets and no deletions.
  const entitlementsUrl = process.env.ENTITLEMENTS_MCP_URL;
  const keycloakAdminUrl = process.env.KEYCLOAK_ADMIN_URL;
  const deletion =
    entitlementsUrl && keycloakAdminUrl
      ? createDeletionActivities({
          db,
          clock: () => new Date(),
          ...mcpErasers(
            (ref, server, tool) =>
              callMcpTool(
                {
                  url: server === "billing" ? env("BILLING_MCP_URL") : entitlementsUrl,
                  tokenFor: tokenFor(ref),
                },
                tool,
                {},
              ),
            { billingErase: SCOPES.billingErase, entitlementsErase: SCOPES.entitlementsErase },
          ),
          identity: {
            async deleteAccount(customerId) {
              const admin = await connectKeycloakAdmin({
                url: keycloakAdminUrl,
                username: env("KEYCLOAK_ADMIN_USER"),
                password: env("KEYCLOAK_ADMIN_PASSWORD"),
              });
              return deleteCustomerAccount(admin, customerId, env("KEYCLOAK_REALM"));
            },
          },
        })
      : {};

  const worker = await createTicketWorker({
    connection: await NativeConnection.connect({ address: env("TEMPORAL_ADDRESS") }),
    namespace: env("TEMPORAL_NAMESPACE"),
    taskQueue: env("TEMPORAL_TASK_QUEUE"),
    activities: { ...activities, ...deletion },
  });
  console.log("worker started");
  await worker.run();
}

start().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
