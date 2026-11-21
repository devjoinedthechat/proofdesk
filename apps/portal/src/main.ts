import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { type AppDatabase, connect } from "@proofdesk/db";
import { createApprovalDelivery, createDispatch } from "@proofdesk/dispatch";
import {
  CLIENTS,
  createGrantSigner,
  createTokenVerifier,
  type GrantKey,
} from "@proofdesk/identity";
import { env, main, serve } from "@proofdesk/service";
import { startTelemetry } from "@proofdesk/telemetry";
import { Client, Connection } from "@temporalio/client";
import { createPortalApp } from "./app.ts";
import { mountUi } from "./ui.ts";

main(async () => {
  const issuer = env("KEYCLOAK_ISSUER");
  const connection = await Connection.connect({ address: env("TEMPORAL_ADDRESS") });
  const temporal = new Client({ connection, namespace: env("TEMPORAL_NAMESPACE") });
  const taskQueue = env("TEMPORAL_TASK_QUEUE");

  const app = createPortalApp({
    // A span per request, in the trace of the ticket the caller is working on.
    telemetry: startTelemetry({
      serviceName: "proofdesk-portal",
      endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    }).telemetry,
    db: connect<AppDatabase>(env("PORTAL_DATABASE_URL")),
    grantsDb: connect<AppDatabase>(env("GRANTS_DATABASE_URL")),
    verify: createTokenVerifier({
      issuer,
      audience: CLIENTS.portal,
      backchannel: process.env.KEYCLOAK_BACKCHANNEL_URL,
    }),
    signer: await createGrantSigner({
      issuer: env("GRANT_ISSUER"),
      audience: issuer,
      // The signing key comes from a file where one is mounted, and from the
      // environment otherwise.
      key: JSON.parse(
        process.env.GRANT_KEY_FILE
          ? readFileSync(process.env.GRANT_KEY_FILE, "utf8")
          : env("GRANT_KEY_JSON"),
      ) as GrantKey,
    }),
    clock: () => new Date(),
    newId: (prefix) => `${prefix}_${randomUUID().replaceAll("-", "")}`,
    // The portal records each piece of work before trying to start it, so
    // this may fail without losing anything.
    dispatch: createDispatch(temporal, {
      taskQueue,
      canaryTaskQueue: process.env.TEMPORAL_CANARY_TASK_QUEUE,
    }),
    decideApproval: createApprovalDelivery(temporal),
  });
  mountUi(app, { issuer, clientId: CLIENTS.portalWeb });
  return serve(app, { port: Number(env("PORT")) });
});
