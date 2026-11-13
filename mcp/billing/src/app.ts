import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type BillingClient, createBillingClient } from "@proofdesk/billing";
import {
  bearerToken,
  CLIENTS,
  SCOPES,
  type TokenClient,
  TokenError,
  type TokenVerifier,
  type VerifiedToken,
} from "@proofdesk/identity";
import { createJsonApp, ServiceApiError } from "@proofdesk/service";
import { z } from "zod";

export type BillingMcpDeps = {
  /** Verifies tokens addressed to this MCP server. */
  verify: TokenVerifier;
  /** This server's own client, used to exchange a caller's token for a billing token. */
  tokens: TokenClient;
  billingUrl: string;
  /** Defaults to the global fetch. Tests pass the in-process billing service. */
  billingFetch?: (request: Request) => Response | Promise<Response>;
  /** The public URL of this server, as clients reach it. */
  resourceUrl: string;
  /** The authorization server that issues tokens for this server. */
  issuer: string;
};

const METADATA_PATH = "/.well-known/oauth-protected-resource";

const ok = (value: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
});

const failed = (code: string, message: string): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }],
});

/** Runs a tool and turns service and token failures into tool errors the model can read. */
async function attempt(run: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await run());
  } catch (error) {
    if (error instanceof ServiceApiError) return failed(error.code, error.message);
    if (error instanceof TokenError) return failed("not_authorized", error.message);
    throw error;
  }
}

/**
 * Builds the tool list for one request. The caller's token decides which tools
 * exist: a token without the refund scope is not even told the refund tool is
 * there. No tool takes a customer id. The customer is whoever the token is
 * about, so a manipulated model cannot point a tool at someone else.
 */
function buildServer(deps: BillingMcpDeps, caller: VerifiedToken, customerId: string): McpServer {
  const server = new McpServer({ name: "proofdesk-billing", version: "0.1.0" });

  // The caller's token is addressed to this server and is never forwarded.
  // Each call trades it for a billing token that carries one scope.
  async function billing(scope: string): Promise<BillingClient> {
    const { accessToken } = await deps.tokens.exchange(caller.token, CLIENTS.billingApi, scope);
    return createBillingClient({
      baseUrl: deps.billingUrl,
      ...(deps.billingFetch ? { fetch: deps.billingFetch } : {}),
      headers: () => ({ authorization: `Bearer ${accessToken}` }),
    });
  }

  if (caller.scopes.includes(SCOPES.billingRead)) {
    server.registerTool(
      "list_invoices",
      {
        description:
          "Lists the customer's invoices, newest first. Each invoice includes its payments, their status, and any refunds already made against them.",
        inputSchema: {
          invoiceNumber: z
            .string()
            .optional()
            .describe("Return only the invoice with this number, such as INV-000123."),
        },
        annotations: { readOnlyHint: true },
      },
      ({ invoiceNumber }) =>
        attempt(async () => {
          const client = await billing(SCOPES.billingRead);
          const filter = invoiceNumber === undefined ? {} : { number: invoiceNumber };
          return { invoices: await client.listInvoices(customerId, filter) };
        }),
    );

    server.registerTool(
      "list_subscriptions",
      {
        description: "Lists the customer's subscriptions with plan, price, seats and status.",
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
      () =>
        attempt(async () => {
          const client = await billing(SCOPES.billingRead);
          return { subscriptions: await client.listSubscriptions(customerId) };
        }),
    );
  }

  if (caller.scopes.includes(SCOPES.billingRefund)) {
    server.registerTool(
      "create_refund",
      {
        description:
          "Refunds money to the customer against one of their payments. This moves real money and cannot be undone. Repeating a call with the same idempotencyKey returns the first refund instead of paying again.",
        inputSchema: {
          paymentId: z.string().describe("The payment to refund, from list_invoices."),
          amountCents: z.number().int().positive().describe("Amount to refund, in cents."),
          reason: z.enum(["duplicate_charge", "customer_request", "service_credit"]),
          idempotencyKey: z
            .string()
            .min(8)
            .max(200)
            .describe("A stable key for this refund. Reuse it when retrying."),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      },
      ({ idempotencyKey, ...request }) =>
        attempt(async () => {
          const client = await billing(SCOPES.billingRefund);
          return { refund: await client.createRefund(request, idempotencyKey) };
        }),
    );
  }

  return server;
}

export function createBillingMcpApp(deps: BillingMcpDeps) {
  const app = createJsonApp();
  const metadataUrl = new URL(METADATA_PATH, deps.resourceUrl).toString();

  // RFC 9728: tells a client which authorization server issues tokens for this server.
  app.get(METADATA_PATH, (c) =>
    c.json({
      resource: deps.resourceUrl,
      authorization_servers: [deps.issuer],
      scopes_supported: [SCOPES.billingRead, SCOPES.billingRefund],
      bearer_methods_supported: ["header"],
    }),
  );

  app.post("/mcp", async (c) => {
    const token = bearerToken(c.req.raw);
    const caller = token ? await deps.verify(token) : null;
    if (!caller) {
      c.header("WWW-Authenticate", `Bearer resource_metadata="${metadataUrl}"`);
      return c.json(
        { error: { code: "unauthenticated", message: "A valid token is required" } },
        401,
      );
    }
    // Billing tools act on one customer's records, so the token must be about one.
    if (!caller.tenantId || !caller.customerId) {
      return c.json(
        { error: { code: "forbidden", message: "The token does not act for a customer" } },
        403,
      );
    }

    // Stateless: each request gets its own server, so nothing about one caller
    // can leak into another caller's request.
    const server = buildServer(deps, caller, caller.customerId);
    // No session id generator means no sessions.
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw, {
      authInfo: { token: caller.token, clientId: caller.client, scopes: caller.scopes },
    });
  });

  app.on(["GET", "DELETE"], "/mcp", (c) => {
    c.header("Allow", "POST");
    return c.json({ error: { code: "method_not_allowed", message: "Use POST" } }, 405);
  });

  return app;
}
