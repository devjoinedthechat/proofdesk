import { connect } from "@proofdesk/db";
import type { DocumentsDatabase } from "@proofdesk/documents";
import { CLIENTS, createTokenVerifier } from "@proofdesk/identity";
import { env, main, serve } from "@proofdesk/service";
import { createDocumentsMcpApp } from "./app.ts";

main(async () => {
  const issuer = env("KEYCLOAK_ISSUER");
  const app = createDocumentsMcpApp({
    db: connect<DocumentsDatabase>(env("DOCUMENTS_DATABASE_URL")),
    // No embedder: the help centre is searched by full text. The queries are
    // written by the model that calls the tool.
    verify: createTokenVerifier({ issuer, audience: CLIENTS.documentsMcp }),
    resourceUrl: env("PUBLIC_URL"),
    issuer,
  });
  return serve(app, { port: Number(env("PORT")) });
});
