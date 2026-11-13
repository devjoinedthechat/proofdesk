import { fileURLToPath } from "node:url";
import { type NativeConnection, Worker } from "@temporalio/worker";
import type { Activities } from "./activities.ts";

export const TASK_QUEUE = "tickets";

/** The workflow id for a ticket. One ticket has at most one workflow. */
export const workflowIdFor = (ticketId: string) => `ticket-${ticketId}`;

export function createTicketWorker(options: {
  connection: NativeConnection;
  namespace: string;
  taskQueue?: string;
  activities: Activities;
}): Promise<Worker> {
  return Worker.create({
    connection: options.connection,
    namespace: options.namespace,
    taskQueue: options.taskQueue ?? TASK_QUEUE,
    workflowsPath: fileURLToPath(new URL("./workflows.ts", import.meta.url)),
    activities: options.activities,
  });
}
