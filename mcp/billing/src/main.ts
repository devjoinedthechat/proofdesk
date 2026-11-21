import { CLIENTS, createTokenClient, createTokenVerifier } from "@proofdesk/identity";
import { env, main, serve } from "@proofdesk/service";
import { startTelemetry } from "@proofdesk/telemetry";
import { createBillingMcpApp } from "./app.ts";

main(async () => {
  const issuer = env("KEYCLOAK_ISSUER");
  const app = createBillingMcpApp({
    // A span per request, in the trace of the ticket the caller is working on.
    telemetry: startTelemetry({
      serviceName: "proofdesk-billing-mcp",
      endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    }).telemetry,
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
