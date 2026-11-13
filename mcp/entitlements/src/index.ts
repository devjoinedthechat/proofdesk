import { createEntitlementsClient, type EntitlementsClient } from "@proofdesk/entitlements";
import { CLIENTS, SCOPES, type TokenClient, type TokenVerifier } from "@proofdesk/identity";
import { createServiceMcpApp, defineTool, type ServiceTool } from "@proofdesk/mcp-server";
import { z } from "zod";

export const ENTITLEMENTS_TOOLS: ServiceTool<EntitlementsClient>[] = [
  defineTool({
    name: "get_entitlement",
    scope: SCOPES.entitlementsRead,
    description:
      "Shows what the customer's workspace is currently entitled to: plan, seats and whether access is active.",
    input: z.object({}),
    writes: false,
    run: async (client: EntitlementsClient, customerId) => ({
      entitlement: await client.getEntitlement(customerId),
    }),
  }),
  defineTool({
    name: "set_entitlement",
    scope: SCOPES.entitlementsWrite,
    description:
      "Sets the plan and seats the customer's workspace is entitled to. Repeating a call with the same idempotencyKey returns the first result instead of writing again.",
    input: z.object({
      planCode: z.string().min(1),
      seats: z.number().int().min(1).max(500),
      idempotencyKey: z.string().min(8).max(200),
    }),
    writes: true,
    run: async (client: EntitlementsClient, customerId, { idempotencyKey, ...request }) => ({
      entitlement: await client.setEntitlement(customerId, request, idempotencyKey),
    }),
  }),
];

export type EntitlementsMcpDeps = {
  verify: TokenVerifier;
  tokens: TokenClient;
  entitlementsUrl: string;
  entitlementsFetch?: (request: Request) => Response | Promise<Response>;
  resourceUrl: string;
  issuer: string;
};

export function createEntitlementsMcpApp(deps: EntitlementsMcpDeps) {
  return createServiceMcpApp<EntitlementsClient>({
    name: "proofdesk-entitlements",
    tools: ENTITLEMENTS_TOOLS,
    verify: deps.verify,
    tokens: deps.tokens,
    downstreamAudience: CLIENTS.entitlementsApi,
    clientFor: (accessToken) =>
      createEntitlementsClient({
        baseUrl: deps.entitlementsUrl,
        ...(deps.entitlementsFetch ? { fetch: deps.entitlementsFetch } : {}),
        headers: () => ({ authorization: `Bearer ${accessToken}` }),
      }),
    resourceUrl: deps.resourceUrl,
    issuer: deps.issuer,
  });
}
