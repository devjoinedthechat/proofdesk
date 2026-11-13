import { connect } from "@proofdesk/db";
import { createVoyageEmbedder, type DocumentsDatabase } from "@proofdesk/documents";
import { CLIENTS, createTokenVerifier } from "@proofdesk/identity";
import { env, main, serve } from "@proofdesk/service";
import { createDocumentsMcpApp } from "./app.ts";

main(async () => {
  const issuer = env("KEYCLOAK_ISSUER");
  const app = createDocumentsMcpApp({
    db: connect<DocumentsDatabase>(env("DOCUMENTS_DATABASE_URL")),
    // Queries must be embedded by the model that embedded the documents.
    embedder: createVoyageEmbedder({ apiKey: env("VOYAGE_API_KEY") }),
    verify: createTokenVerifier({ issuer, audience: CLIENTS.documentsMcp }),
    resourceUrl: env("PUBLIC_URL"),
    issuer,
  });
  return serve(app, { port: Number(env("PORT")) });
});
