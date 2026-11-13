import { fileURLToPath } from "node:url";
import { Context } from "@temporalio/activity";
import { type NativeConnection, Worker } from "@temporalio/worker";
import type { Activities } from "./activities.ts";

export const TASK_QUEUE = "tickets";

const HEARTBEAT_MS = 2_000;

/** The workflow id for a ticket. One ticket has at most one workflow. */
export const workflowIdFor = (ticketId: string) => `ticket-${ticketId}`;

/**
 * Makes every activity report in while it runs. Without this, the engine only
 * learns that a worker died when the activity's full timeout expires.
 */
function withHeartbeats(activities: Activities): Activities {
  const wrapped: Record<string, unknown> = {};
  for (const [name, activity] of Object.entries(activities)) {
    wrapped[name] = async (...args: unknown[]) => {
      const context = Context.current();
      const timer = setInterval(() => context.heartbeat(), HEARTBEAT_MS);
      try {
        return await (activity as (...input: unknown[]) => Promise<unknown>)(...args);
      } finally {
        clearInterval(timer);
      }
    };
  }
  return wrapped as Activities;
}

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
    activities: withHeartbeats(options.activities),
  });
}
