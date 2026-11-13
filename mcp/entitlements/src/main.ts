import { CLIENTS, createTokenClient, createTokenVerifier } from "@proofdesk/identity";
import { env, main, serve } from "@proofdesk/service";
import { createEntitlementsMcpApp } from "./index.ts";

main(async () => {
  const issuer = env("KEYCLOAK_ISSUER");
  const app = createEntitlementsMcpApp({
    verify: createTokenVerifier({ issuer, audience: CLIENTS.entitlementsMcp }),
    tokens: createTokenClient({
      issuer,
      clientId: CLIENTS.entitlementsMcp,
      clientSecret: env("ENTITLEMENTS_MCP_CLIENT_SECRET"),
    }),
    entitlementsUrl: env("ENTITLEMENTS_URL"),
    resourceUrl: env("PUBLIC_URL"),
    issuer,
  });
  return serve(app, { port: Number(env("PORT")) });
});
