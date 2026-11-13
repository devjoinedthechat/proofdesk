import { fileURLToPath } from "node:url";
import { type Attributes, noTelemetry, type Telemetry } from "@proofdesk/telemetry";
import { Context } from "@temporalio/activity";
import { type NativeConnection, Worker } from "@temporalio/worker";
import type { Activities } from "./activities.ts";
import type { DeletionActivities } from "./deletion.ts";
import type { WatchdogActivities } from "./watchdog.ts";

/** Everything a worker can run. Deletion is optional: not every worker is given the means. */
export type WorkerActivities = Activities &
  Partial<DeletionActivities> &
  Partial<WatchdogActivities>;

export const TASK_QUEUE = "tickets";

const HEARTBEAT_MS = 2_000;

/** The workflow id for a ticket. One ticket has at most one workflow. */
export const workflowIdFor = (ticketId: string) => `ticket-${ticketId}`;

/**
 * Makes every activity report in while it runs. Without this, the engine only
 * learns that a worker died when the activity's full timeout expires.
 */
function withHeartbeats(activities: WorkerActivities, telemetry: Telemetry): WorkerActivities {
  const wrapped: Record<string, unknown> = {};
  for (const [name, activity] of Object.entries(activities)) {
    wrapped[name] = async (...args: unknown[]) => {
      const context = Context.current();
      const timer = setInterval(() => context.heartbeat(), HEARTBEAT_MS);
      const started = Date.now();
      const attributes = activityAttributes(name, args[0]);
      try {
        return await telemetry.span(`activity.${name}`, attributes, () =>
          (activity as (...input: unknown[]) => Promise<unknown>)(...args),
        );
      } finally {
        clearInterval(timer);
        telemetry.record("activityLatencyMs", Date.now() - started, attributes);
      }
    };
  }
  return wrapped as WorkerActivities;
}

/**
 * What a span may say about an activity: its name, and the ticket, tenant
 * and step from its input when they are there. Activity inputs hold only
 * identifiers by design, and only these are read.
 */
export function activityAttributes(name: string, input: unknown): Attributes {
  const attributes: Attributes = { "activity.name": name };
  if (typeof input !== "object" || input === null) return attributes;
  const fields = input as { ref?: unknown; step?: unknown };
  const ref = (typeof fields.ref === "object" && fields.ref !== null ? fields.ref : input) as {
    ticketId?: unknown;
    tenantId?: unknown;
  };
  if (typeof ref.ticketId === "string") attributes["ticket.id"] = ref.ticketId;
  if (typeof ref.tenantId === "string") attributes["tenant.id"] = ref.tenantId;
  if (typeof fields.step === "number") attributes["run.step"] = fields.step;
  return attributes;
}

export function createTicketWorker(options: {
  connection: NativeConnection;
  namespace: string;
  taskQueue?: string;
  activities: WorkerActivities;
  telemetry?: Telemetry;
}): Promise<Worker> {
  return Worker.create({
    connection: options.connection,
    namespace: options.namespace,
    taskQueue: options.taskQueue ?? TASK_QUEUE,
    workflowsPath: fileURLToPath(new URL("./workflows.ts", import.meta.url)),
    activities: withHeartbeats(options.activities, options.telemetry ?? noTelemetry),
  });
}
