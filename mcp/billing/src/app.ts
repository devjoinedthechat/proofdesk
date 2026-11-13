import { type BillingClient, createBillingClient } from "@proofdesk/billing";
import { CLIENTS, type TokenClient, type TokenVerifier } from "@proofdesk/identity";
import { createServiceMcpApp } from "@proofdesk/mcp-server";
import { BILLING_TOOLS } from "./tools.ts";

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

export function createBillingMcpApp(deps: BillingMcpDeps) {
  return createServiceMcpApp<BillingClient>({
    name: "proofdesk-billing",
    tools: BILLING_TOOLS,
    verify: deps.verify,
    tokens: deps.tokens,
    downstreamAudience: CLIENTS.billingApi,
    clientFor: (accessToken) =>
      createBillingClient({
        baseUrl: deps.billingUrl,
        ...(deps.billingFetch ? { fetch: deps.billingFetch } : {}),
        headers: () => ({ authorization: `Bearer ${accessToken}` }),
      }),
    resourceUrl: deps.resourceUrl,
    issuer: deps.issuer,
  });
}
