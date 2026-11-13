import { pathToFileURL } from "node:url";
import { callMcpTool, listMcpTools, screenTicket } from "@proofdesk/agent";
import { type AppDatabase, connect } from "@proofdesk/db";
import {
  ANTHROPIC_PRICES,
  createAnthropicProvider,
  createGateway,
  type ModelProvider,
  type PriceTable,
} from "@proofdesk/gateway";
import {
  CLIENTS,
  createTokenClient,
  createToolTokenSource,
  SCOPES,
  TokenError,
} from "@proofdesk/identity";
import { createToolPolicy, type InvoiceRecords } from "@proofdesk/policy";
import { env } from "@proofdesk/service";
import { NativeConnection } from "@temporalio/worker";
import { createActivities, type TicketRef } from "./activities.ts";
import { createDbLedger } from "./ledger.ts";
import { createTicketWorker } from "./worker.ts";

/**
 * The model provider. By default this is Anthropic. MODEL_PROVIDER_MODULE can
 * name a module that exports another provider and its prices, which is how a
 * second provider is plugged in and how tests run without a model.
 */
async function loadProvider(): Promise<{ provider: ModelProvider; prices: PriceTable }> {
  const path = process.env.MODEL_PROVIDER_MODULE;
  if (!path) return { provider: createAnthropicProvider(), prices: ANTHROPIC_PRICES };
  const module = (await import(pathToFileURL(path).href)) as {
    default: ModelProvider;
    prices: PriceTable;
  };
  return { provider: module.default, prices: module.prices };
}

async function start() {
  const db = connect<AppDatabase>(env("WORKER_DATABASE_URL"));
  const { provider, prices } = await loadProvider();
  const gateway = createGateway({
    routes: [{ provider }],
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
  const mcp = (ref: TicketRef) => ({
    url: env("BILLING_MCP_URL"),
    async tokenFor(scope: string) {
      try {
        return (await toolTokens.forTool({ ticketId: ref.ticketId, scope })).accessToken;
      } catch (error) {
        // The grant does not cover this scope, or no longer holds.
        if (error instanceof TokenError) return null;
        throw error;
      }
    },
  });

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
        mcp(ref),
        { name: "list_invoices", scope: SCOPES.billingRead },
        {},
      );
      if (result.isError) throw new Error(`Could not read invoices for policy: ${result.content}`);
      return (JSON.parse(result.content) as { invoices: InvoiceRecords }).invoices;
    },
    tools: {
      list: (ref) =>
        listMcpTools({ ...mcp(ref), scopes: [SCOPES.billingRead, SCOPES.billingRefund] }),
      call: (ref, tool, input) =>
        callMcpTool(mcp(ref), { name: tool.definition.name, scope: tool.scope }, input),
    },
  });

  const worker = await createTicketWorker({
    connection: await NativeConnection.connect({ address: env("TEMPORAL_ADDRESS") }),
    namespace: env("TEMPORAL_NAMESPACE"),
    taskQueue: env("TEMPORAL_TASK_QUEUE"),
    activities,
  });
  console.log("worker started");
  await worker.run();
}

start().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
