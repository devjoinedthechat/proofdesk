import { CLIENTS, createTokenClient, createTokenVerifier } from "@proofdesk/identity";
import { env, main, serve } from "@proofdesk/service";
import { startTelemetry } from "@proofdesk/telemetry";
import { createEntitlementsMcpApp } from "./index.ts";

main(async () => {
  const issuer = env("KEYCLOAK_ISSUER");
  const app = createEntitlementsMcpApp({
    // A span per request, in the trace of the ticket the caller is working on.
    telemetry: startTelemetry({
      serviceName: "proofdesk-entitlements-mcp",
      endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    }).telemetry,
    verify: createTokenVerifier({
      issuer,
      audience: CLIENTS.entitlementsMcp,
      backchannel: process.env.KEYCLOAK_BACKCHANNEL_URL,
    }),
    tokens: createTokenClient({
      issuer,
      backchannel: process.env.KEYCLOAK_BACKCHANNEL_URL,
      clientId: CLIENTS.entitlementsMcp,
      clientSecret: env("ENTITLEMENTS_MCP_CLIENT_SECRET"),
    }),
    entitlementsUrl: env("ENTITLEMENTS_URL"),
    resourceUrl: env("PUBLIC_URL"),
    issuer,
  });
  return serve(app, { port: Number(env("PORT")) });
});
