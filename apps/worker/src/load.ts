import { randomBytes } from "node:crypto";
import { cpus, totalmem } from "node:os";
import { parseArgs } from "node:util";
import {
  callMcpTool,
  listMcpTools,
  type McpToolDescriptor,
  type ToolOutcome,
} from "@proofdesk/agent";
import { createBillingApp } from "@proofdesk/billing";
import {
  type AppDatabase,
  appendAudit,
  asRole,
  connect,
  DB_ROLES,
  TEST_ROLE_PASSWORD,
  verifyAudit,
} from "@proofdesk/db";
import { createGateway } from "@proofdesk/gateway";
import {
  bearerToken,
  CLIENTS,
  connectKeycloakAdmin,
  createGrantSigner,
  createTokenClient,
  createTokenVerifier,
  createToolTokenSource,
  generateGrantKey,
  principalFrom,
  provisionCustomer,
  provisionRealm,
  realmIssuer,
  SCOPES,
  TokenError,
} from "@proofdesk/identity";
import { BILLING_TOOLS, createBillingMcpApp } from "@proofdesk/mcp-billing";
import { createToolPolicy, invoiceRecords, policyVersion } from "@proofdesk/policy";
import { createPortalApp, GRANT_SCOPES } from "@proofdesk/portal";
import { ServiceApiError } from "@proofdesk/service";
import {
  baseWorld,
  createSimEnv,
  loadWorld,
  prepareTemplates,
  ScenarioBuilder,
  type SimEnv,
} from "@proofdesk/simulator";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection } from "@temporalio/worker";
import { z } from "zod";
import {
  type Started,
  startKeycloak,
  startPostgres,
  startTemporal,
} from "../../../test/containers.ts";
import { createActivities, type TicketRef } from "./activities.ts";
import { createDbLedger } from "./ledger.ts";
import ruleModel, { prices } from "./testing/duplicate-refund-model.ts";
import { createTicketWorker } from "./worker.ts";

// Measures what the system itself costs per ticket, with the model taken out.
//
// Every ticket is a duplicate charge that the agent refunds: three model
// turns, two tool calls, seven durable steps. The model is the rule-based
// stand-in, which answers at once, so the time measured is the workflow
// engine, the database, the policy layer and the billing service.
//
// Each level is measured two ways. `direct`: tool calls go straight to the
// billing service. `token chain`: as in production, every tool call gets a
// signed assertion from the portal, trades it at Keycloak for a token of one
// scope, and calls the MCP server, which exchanges that token at Keycloak
// again for one addressed to billing. What is still left out is said in
// docs/load.md: the services run in this process, not in containers.

const { values } = parseArgs({
  options: {
    tickets: { type: "string", default: "200" },
    concurrency: { type: "string", default: "1,8,32" },
    "audit-entries": { type: "string", default: "3000" },
    "audit-writers": { type: "string", default: "1,8,32" },
    paths: { type: "string", default: "direct,chain" },
  },
});
const TICKETS = Number(values.tickets);
const LEVELS = String(values.concurrency).split(",").map(Number);
const AUDIT_ENTRIES = Number(values["audit-entries"]);
const AUDIT_WRITERS = String(values["audit-writers"]).split(",").map(Number);
const PATHS = String(values.paths).split(",") as ("direct" | "chain")[];

const GRANTED = ["billing:read", "billing:refund"];
const refundTools = BILLING_TOOLS.filter((tool) => GRANTED.includes(tool.scope));
const descriptors: McpToolDescriptor[] = refundTools.map((tool) => ({
  definition: {
    name: tool.name,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.input) as Record<string, unknown>,
  },
  writes: tool.writes,
  scope: tool.scope,
  endpoint: "direct",
}));

/** Customer names made of letters only: an email address is derived from them. */
const letters = (index: number) =>
  [...String(index).padStart(4, "0")].map((digit) => "abcdefghij"[Number(digit)]).join("");

/** One company with a duplicate charge and a ticket about it for every customer. */
async function company(env: SimEnv, count: number): Promise<TicketRef[]> {
  const builder = new ScenarioBuilder(baseWorld(), `load-${randomBytes(4).toString("hex")}`);
  const refs: TicketRef[] = [];
  for (let index = 0; index < count; index++) {
    const slug = index % 2 === 0 ? "harbor" : "tallyfield";
    const customer = builder.customer(slug, { name: `Load ${letters(index)}` });
    const subscription = builder.subscription(customer, {
      plan: slug === "harbor" ? "team-monthly" : "pro-monthly",
      seats: 3,
      startedDaysAgo: 200,
    });
    const invoice = builder.invoice(subscription, { issuedDaysAgo: 5 });
    builder.payment(invoice, { daysAgo: 5 });
    builder.payment(invoice, { daysAgo: 5, minutesLater: 2 });
    const ticket = builder.ticket(customer, {
      subject: "Charged twice",
      body: `I was charged twice for invoice ${invoice.number}. Please refund the second payment.`,
    });
    refs.push({ ticketId: ticket.id, tenantId: customer.tenantId, customerId: customer.id });
  }
  await loadWorld(builder.added, env.dbs);
  // The daily cap on the agent's refunds would send every ticket after the
  // first few to staff. It is lifted here, because this measures speed.
  await env.dbs.app
    .updateTable("tenants")
    .set({ agentDailyRefundCapCents: 2_000_000_000 })
    .execute();
  return refs;
}

const percentile = (sorted: number[], share: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] ?? 0;

async function lanes<Item>(items: Item[], width: number, work: (item: Item) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: width }, async () => {
      for (let item = items[next++]; item !== undefined; item = items[next++]) await work(item);
    }),
  );
}

type TicketRow = {
  path: "direct" | "chain";
  concurrency: number;
  tickets: number;
  seconds: number;
  p50: number;
  p95: number;
  auditEntries: number;
};

const GRANT_ISSUER = "https://grants.proofdesk.load";
const MCP_URL = "http://billing-mcp.load/mcp";

/**
 * The production path for the agent's tools: assertions from the portal,
 * tokens from Keycloak, the billing MCP server and billing behind it, each
 * checking the token it is given. Built for one company and its customers.
 */
async function tokenChain(keycloakUrl: string, env: SimEnv, refs: TicketRef[]) {
  const realm = `load_${randomBytes(4).toString("hex")}`;
  const issuer = realmIssuer(keycloakUrl, realm);
  const admin = await connectKeycloakAdmin({
    url: keycloakUrl,
    username: "admin",
    password: "admin",
  });
  const key = await generateGrantKey();
  const secrets = { worker: "load-worker", billingMcp: "load-mcp", entitlementsMcp: "load-ent" };
  await provisionRealm(admin, {
    realm,
    grantIssuer: GRANT_ISSUER,
    grantPublicKey: key.publicKeySpki,
    grantKeyId: key.kid,
    secrets,
    insecureHttp: true,
  });
  // A Keycloak account and a ticket grant for every customer, as filing the
  // ticket through the portal would have made.
  const customers = await env.dbs.app.selectFrom("customers").selectAll().execute();
  const byId = new Map(customers.map((customer) => [customer.id, customer]));
  await lanes(refs, 8, async (ref) => {
    const customer = byId.get(ref.customerId);
    if (!customer) throw new Error(`No customer ${ref.customerId}`);
    await provisionCustomer(admin, customer, realm);
  });
  const now = new Date();
  await env.dbs.app
    .insertInto("ticketGrants")
    .values(
      refs.map((ref) => ({
        ticketId: ref.ticketId,
        tenantId: ref.tenantId,
        customerId: ref.customerId,
        scopes: GRANT_SCOPES.refund,
        createdAt: now,
        expiresAt: new Date(now.getTime() + 86_400_000),
        revokedAt: null,
      })),
    )
    .execute();

  const portal = createPortalApp({
    db: connect<AppDatabase>(asRole(env.urls.app, DB_ROLES.portal, TEST_ROLE_PASSWORD), {
      maxConnections: 10,
    }),
    grantsDb: connect<AppDatabase>(asRole(env.urls.app, DB_ROLES.grants, TEST_ROLE_PASSWORD), {
      maxConnections: 10,
    }),
    verify: createTokenVerifier({ issuer, audience: CLIENTS.portal }),
    signer: await createGrantSigner({ issuer: GRANT_ISSUER, audience: issuer, key }),
    clock: () => new Date(),
    newId: (prefix) => `${prefix}_${randomBytes(6).toString("hex")}`,
  });
  const verifyBilling = createTokenVerifier({ issuer, audience: CLIENTS.billingApi });
  const billingApp = createBillingApp({
    db: env.serviceDbs.billing,
    clock: () => env.now,
    newId: (prefix) => `${prefix}_${randomBytes(6).toString("hex")}`,
    authenticate: async (request) => {
      const token = bearerToken(request);
      const verified = token ? await verifyBilling(token) : null;
      return verified ? principalFrom(verified, "agent") : null;
    },
  });
  const mcpApp = createBillingMcpApp({
    verify: createTokenVerifier({ issuer, audience: CLIENTS.billingMcp }),
    tokens: createTokenClient({
      issuer,
      clientId: CLIENTS.billingMcp,
      clientSecret: secrets.billingMcp,
    }),
    billingUrl: "http://billing.load",
    billingFetch: (request) => billingApp.fetch(request),
    resourceUrl: "http://billing-mcp.load",
    issuer,
  });
  const toolTokens = createToolTokenSource({
    worker: createTokenClient({ issuer, clientId: CLIENTS.worker, clientSecret: secrets.worker }),
    portalUrl: "http://portal.load",
    portalFetch: (request) => portal.fetch(request),
  });
  const tokenFor = (ref: TicketRef) => async (scope: string) => {
    try {
      return (await toolTokens.forTool({ ticketId: ref.ticketId, scope })).accessToken;
    } catch (error) {
      if (error instanceof TokenError) return null;
      throw error;
    }
  };
  const fetchMcp = (request: Request) => mcpApp.fetch(request);
  return {
    tools: {
      list: (ref: TicketRef) =>
        listMcpTools({
          url: MCP_URL,
          scopes: [SCOPES.billingRead, SCOPES.billingRefund],
          tokenFor: tokenFor(ref),
          fetch: fetchMcp,
        }),
      call: (ref: TicketRef, tool: McpToolDescriptor, input: Record<string, unknown>) =>
        callMcpTool(
          { url: MCP_URL, tokenFor: tokenFor(ref), fetch: fetchMcp },
          { name: tool.definition.name, scope: tool.scope },
          input,
        ),
    },
    async invoices(ref: TicketRef) {
      const result = await callMcpTool(
        { url: MCP_URL, tokenFor: tokenFor(ref), fetch: fetchMcp },
        { name: "list_invoices", scope: SCOPES.billingRead },
        {},
      );
      if (result.isError) throw new Error(`Could not read invoices: ${result.content}`);
      return invoiceRecords.parse((JSON.parse(result.content) as { invoices?: unknown }).invoices);
    },
  };
}

async function tickets(
  adminUrl: string,
  native: NativeConnection,
  client: Client,
  concurrency: number,
  path: "direct" | "chain",
  keycloakUrl?: string,
): Promise<TicketRow> {
  const env = await createSimEnv(adminUrl, { serviceConnections: 20 });
  const db = connect<AppDatabase>(asRole(env.urls.app, DB_ROLES.worker, TEST_ROLE_PASSWORD), {
    maxConnections: 20,
  });
  const refs = await company(env, TICKETS);
  const chain =
    path === "chain" && keycloakUrl ? await tokenChain(keycloakUrl, env, refs) : undefined;
  const clientsFor = (ref: TicketRef) =>
    env.clientsFor({
      tenantId: ref.tenantId,
      actor: "agent",
      subject: `agent:ticket:${ref.ticketId}`,
      customerId: ref.customerId,
      scopes: GRANTED,
    });

  const activities = createActivities({
    db,
    // The gateway as in production: every model call is budgeted against a
    // ledger in the database before it is made, and settled afterwards.
    gateway: createGateway({
      routes: [{ provider: ruleModel }],
      prices,
      ledger: createDbLedger(db),
      limits: { perTicketMicros: 500_000, perTenantMicros: 50_000_000 },
    }),
    versions: { model: "rule-model", prompt: "load", policy: policyVersion() },
    policy: createToolPolicy(),
    clock: () => env.now,
    invoices: (ref) =>
      chain ? chain.invoices(ref) : clientsFor(ref).billing.listInvoices(ref.customerId),
    tools: chain?.tools ?? {
      list: async () => descriptors,
      async call(ref, descriptor, input): Promise<ToolOutcome> {
        const tool = refundTools.find((candidate) => candidate.name === descriptor.definition.name);
        if (!tool) throw new Error(`Unknown tool ${descriptor.definition.name}`);
        try {
          const result = await tool.run(clientsFor(ref).billing, ref.customerId, input);
          return { content: JSON.stringify(result), isError: false };
        } catch (error) {
          if (!(error instanceof ServiceApiError)) throw error;
          return { content: JSON.stringify({ error: { code: error.code } }), isError: true };
        }
      },
    },
  });

  const taskQueue = `load-${randomBytes(4).toString("hex")}`;
  const worker = await createTicketWorker({
    connection: native,
    namespace: "default",
    taskQueue,
    activities,
  });
  const running = worker.run();

  const times: number[] = [];
  const started = performance.now();
  try {
    await lanes(refs, concurrency, async (ref) => {
      const from = performance.now();
      const handle = await client.workflow.start("ticketWorkflow", {
        args: [ref],
        taskQueue,
        workflowId: `ticket-${ref.ticketId}-${taskQueue}`,
      });
      const result = (await handle.result()) as { outcome: string };
      if (result.outcome !== "refunded") {
        throw new Error(`Ticket ${ref.ticketId} ended as ${result.outcome}, not refunded`);
      }
      times.push(performance.now() - from);
    });
    const seconds = (performance.now() - started) / 1000;

    // A fast run that did the wrong thing is not a result. One refund per
    // ticket, and one unbroken audit chain.
    const refunds = await env.dbs.billing
      .selectFrom("refunds")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      // The agent's refunds carry its idempotency key; the seeded history does not.
      .where("idempotencyKey", "like", "%:create_refund:%")
      .executeTakeFirstOrThrow();
    if (Number(refunds.count) !== refs.length) {
      throw new Error(`${refunds.count} refunds for ${refs.length} tickets`);
    }
    const problems = await verifyAudit(env.dbs.app);
    if (problems.length > 0) throw new Error(`The audit chain is broken: ${problems[0]?.problem}`);
    const audit = await env.dbs.app
      .selectFrom("auditLog")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow();

    times.sort((a, b) => a - b);
    return {
      path,
      concurrency,
      tickets: refs.length,
      seconds,
      p50: percentile(times, 0.5),
      p95: percentile(times, 0.95),
      auditEntries: Number(audit.count),
    };
  } finally {
    worker.shutdown();
    await running;
    await db.destroy();
    await env.dispose();
  }
}

/** How fast the one audit chain takes entries, with nothing else going on. */
async function audit(adminUrl: string, writers: number) {
  const env = await createSimEnv(adminUrl);
  const db = connect<AppDatabase>(asRole(env.urls.app, DB_ROLES.worker, TEST_ROLE_PASSWORD), {
    maxConnections: writers,
  });
  try {
    const entries = Array.from({ length: AUDIT_ENTRIES }, (_, index) => index);
    const started = performance.now();
    await lanes(entries, writers, async (index) => {
      await appendAudit(db, {
        tenantId: "ten_harbor",
        at: env.now,
        actor: "agent",
        event: "tool_call",
        detail: { step: index, tool: "create_refund", verdict: "allow", failed: false },
      });
    });
    const seconds = (performance.now() - started) / 1000;
    const problems = await verifyAudit(env.dbs.app);
    if (problems.length > 0) throw new Error(`The audit chain is broken: ${problems[0]?.problem}`);
    return { writers, entries: AUDIT_ENTRIES, seconds };
  } finally {
    await db.destroy();
    await env.dispose();
  }
}

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const line = (cells: string[]) =>
    `| ${cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join(" | ")} |`;
  return [line(headers), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)].join(
    "\n",
  );
}

const [postgres, temporal] = await Promise.all([startPostgres(), startTemporal()]);
const keycloak: Started | undefined = PATHS.includes("chain") ? await startKeycloak() : undefined;
try {
  await prepareTemplates(postgres.url);
  const connection = await Connection.connect({ address: temporal.url });
  const native = await NativeConnection.connect({ address: temporal.url });
  const client = new Client({ connection, namespace: "default" });

  const ticketRows: TicketRow[] = [];
  for (const path of PATHS) {
    for (const level of LEVELS) {
      console.error(`tickets (${path}): ${TICKETS} at ${level} at a time...`);
      ticketRows.push(await tickets(postgres.url, native, client, level, path, keycloak?.url));
    }
  }
  const auditRows = [];
  for (const writers of AUDIT_WRITERS) {
    console.error(`audit: ${AUDIT_ENTRIES} entries from ${writers} writer(s)...`);
    auditRows.push(await audit(postgres.url, writers));
  }
  await native.close();
  await connection.close();

  console.log(
    [
      `Machine: ${cpus().length} cores, ${Math.round(totalmem() / 2 ** 30)} GB, Node ${process.version}, ${process.platform} ${process.arch}.`,
      "",
      table(
        [
          "Tool calls",
          "Tickets at a time",
          "Tickets",
          "Tickets a second",
          "Median",
          "95th percentile",
        ],
        ticketRows.map((row) => [
          row.path === "chain" ? "token chain" : "direct",
          String(row.concurrency),
          String(row.tickets),
          (row.tickets / row.seconds).toFixed(1),
          `${Math.round(row.p50)} ms`,
          `${Math.round(row.p95)} ms`,
        ]),
      ),
      "",
      `Audit entries per ticket: ${((ticketRows[0]?.auditEntries ?? 0) / TICKETS).toFixed(1)}.`,
      "",
      table(
        ["Writers", "Entries", "Entries a second"],
        auditRows.map((row) => [
          String(row.writers),
          String(row.entries),
          Math.round(row.entries / row.seconds).toLocaleString("en-US"),
        ]),
      ),
    ].join("\n"),
  );
} finally {
  await Promise.all([postgres.stop(), temporal.stop(), keycloak?.stop()]);
}
