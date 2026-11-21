import { connect } from "@proofdesk/db";
import type { DocumentsDatabase } from "@proofdesk/documents";
import { CLIENTS, createTokenVerifier } from "@proofdesk/identity";
import { env, main, serve } from "@proofdesk/service";
import { startTelemetry } from "@proofdesk/telemetry";
import { createDocumentsMcpApp } from "./app.ts";

main(async () => {
  const issuer = env("KEYCLOAK_ISSUER");
  const app = createDocumentsMcpApp({
    // A span per request, in the trace of the ticket the caller is working on.
    telemetry: startTelemetry({
      serviceName: "proofdesk-documents-mcp",
      endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    }).telemetry,
    db: connect<DocumentsDatabase>(env("DOCUMENTS_DATABASE_URL")),
    // No embedder: the help centre is searched by full text. The queries are
    // written by the model that calls the tool.
    verify: createTokenVerifier({
      issuer,
      audience: CLIENTS.documentsMcp,
      backchannel: process.env.KEYCLOAK_BACKCHANNEL_URL,
    }),
    resourceUrl: env("PUBLIC_URL"),
    issuer,
  });
  return serve(app, { port: Number(env("PORT")) });
});
