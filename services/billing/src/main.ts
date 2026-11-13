import { randomUUID } from "node:crypto";
import { connect } from "@proofdesk/db";
import { bearerToken, CLIENTS, createTokenVerifier, principalFrom } from "@proofdesk/identity";
import { env, main, serve } from "@proofdesk/service";
import { createBillingApp } from "./app.ts";
import type { BillingDatabase } from "./schema.ts";

// The billing service as a process. It accepts only tokens addressed to it,
// and connects to its database as the restricted billing_app role.
main(async () => {
  const verify = createTokenVerifier({
    issuer: env("KEYCLOAK_ISSUER"),
    audience: CLIENTS.billingApi,
    backchannel: process.env.KEYCLOAK_BACKCHANNEL_URL,
  });
  const app = createBillingApp({
    db: connect<BillingDatabase>(env("BILLING_DATABASE_URL")),
    clock: () => new Date(),
    newId: (prefix) => `${prefix}_${randomUUID().replaceAll("-", "")}`,
    authenticate: async (request) => {
      const token = bearerToken(request);
      const verified = token ? await verify(token) : null;
      return verified ? principalFrom(verified, "agent") : null;
    },
  });
  return serve(app, { port: Number(env("PORT")) });
});
