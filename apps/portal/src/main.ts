import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { type AppDatabase, connect } from "@proofdesk/db";
import {
  CLIENTS,
  createGrantSigner,
  createTokenVerifier,
  type GrantKey,
} from "@proofdesk/identity";
import { env, main, serve } from "@proofdesk/service";
import { Client, Connection, WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { createPortalApp } from "./app.ts";

main(async () => {
  const issuer = env("KEYCLOAK_ISSUER");
  const connection = await Connection.connect({ address: env("TEMPORAL_ADDRESS") });
  const temporal = new Client({ connection, namespace: env("TEMPORAL_NAMESPACE") });
  const taskQueue = env("TEMPORAL_TASK_QUEUE");
  const workflowId = (ticketId: string) => `ticket-${ticketId}`;

  const app = createPortalApp({
    db: connect<AppDatabase>(env("PORTAL_DATABASE_URL")),
    grantsDb: connect<AppDatabase>(env("GRANTS_DATABASE_URL")),
    verify: createTokenVerifier({ issuer, audience: CLIENTS.portal }),
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
    // One ticket has one workflow: the workflow id is derived from the ticket
    // id, so starting it twice is refused by the engine.
    onTicketCreated: async ({ route, ...ref }) => {
      await temporal.workflow.start("ticketWorkflow", {
        args: [ref],
        // A canary build listens on its own queue. Without one configured,
        // every ticket goes to the stable build.
        taskQueue:
          route === "canary" ? (process.env.TEMPORAL_CANARY_TASK_QUEUE ?? taskQueue) : taskQueue,
        workflowId: workflowId(ref.ticketId),
      });
    },
    // One request has one workflow, for the same reason.
    onDeletionRequested: async (ref) => {
      await temporal.workflow
        .start("deletionWorkflow", {
          args: [ref],
          taskQueue,
          workflowId: `deletion-${ref.requestId}`,
        })
        .catch((error: unknown) => {
          if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
        });
    },
    decideApproval: async ({ ticketId, ...decision }) => {
      await temporal.workflow.getHandle(workflowId(ticketId)).signal("approvalDecided", decision);
    },
  });
  return serve(app, { port: Number(env("PORT")) });
});
