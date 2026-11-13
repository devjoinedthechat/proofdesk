import { CLIENTS, createTokenClient, createTokenVerifier } from "@proofdesk/identity";
import { env, main, serve } from "@proofdesk/service";
import { createBillingMcpApp } from "./app.ts";

main(async () => {
  const issuer = env("KEYCLOAK_ISSUER");
  const app = createBillingMcpApp({
    verify: createTokenVerifier({
      issuer,
      audience: CLIENTS.billingMcp,
      backchannel: process.env.KEYCLOAK_BACKCHANNEL_URL,
    }),
    tokens: createTokenClient({
      issuer,
      backchannel: process.env.KEYCLOAK_BACKCHANNEL_URL,
      clientId: CLIENTS.billingMcp,
      clientSecret: env("BILLING_MCP_CLIENT_SECRET"),
    }),
    billingUrl: env("BILLING_URL"),
    resourceUrl: env("PUBLIC_URL"),
    issuer,
  });
  return serve(app, { port: Number(env("PORT")) });
});
