import { connect } from "@proofdesk/db";
import { bearerToken, CLIENTS, createTokenVerifier, principalFrom } from "@proofdesk/identity";
import { env, main, serve } from "@proofdesk/service";
import { createEntitlementsApp } from "./app.ts";
import type { EntitlementsDatabase } from "./schema.ts";

// The entitlements service as a process. It accepts only tokens addressed to
// it, and connects to its database as the restricted entitlements_app role.
main(async () => {
  const verify = createTokenVerifier({
    issuer: env("KEYCLOAK_ISSUER"),
    audience: CLIENTS.entitlementsApi,
  });
  const app = createEntitlementsApp({
    db: connect<EntitlementsDatabase>(env("ENTITLEMENTS_DATABASE_URL")),
    clock: () => new Date(),
    authenticate: async (request) => {
      const token = bearerToken(request);
      const verified = token ? await verify(token) : null;
      return verified ? principalFrom(verified, "agent") : null;
    },
  });
  return serve(app, { port: Number(env("PORT")) });
});
