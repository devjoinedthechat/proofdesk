import {
  type Client,
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError,
} from "@temporalio/client";
import { z } from "zod";

// How a piece of promised work becomes a running workflow. The portal and
// the sweeper both start work from the same outbox rows, so the rules for
// starting it live here, once.

const ref = z.object({ ticketId: z.string(), tenantId: z.string(), customerId: z.string() });
const route = z.enum(["stable", "canary"]);

/** One piece of work for the workflow engine, as stored in the outbox. Identifiers only. */
export const outboxJob = z.discriminatedUnion("kind", [
  /** A new ticket for the agent. */
  z.object({ kind: z.literal("ticket"), ref, route }),
  /** A customer's answer on a ticket the agent asked a question about. */
  z.object({ kind: z.literal("follow_up"), ref, route, messageId: z.string() }),
  /** A customer's request to be deleted. */
  z.object({ kind: z.literal("deletion"), ref: ref.extend({ requestId: z.string() }) }),
]);

export type OutboxJob = z.infer<typeof outboxJob>;

/**
 * `started`: the work is running, or has already run. The promise is kept.
 * `busy`: it could not start yet because the ticket's earlier run is still
 * finishing. Try again shortly.
 */
export type DispatchResult = "started" | "busy";

export type Dispatch = (job: OutboxJob) => Promise<DispatchResult>;

/** A ticket has one workflow id for its whole life, so the engine runs one agent on it at a time. */
export const ticketWorkflowId = (ticketId: string, suffix = "") => `ticket-${ticketId}${suffix}`;
export const deletionWorkflowId = (requestId: string, suffix = "") =>
  `deletion-${requestId}${suffix}`;

/**
 * Starts the workflow for a job. Safe to call any number of times for the
 * same job, from any process: the workflow id decides, and the engine keeps
 * only one.
 */
export function createDispatch(
  client: Client,
  options: {
    taskQueue: string;
    /** Where a canary build listens. Without one, every ticket goes to the stable build. */
    canaryTaskQueue?: string | undefined;
    /** Appended to workflow ids, so that tests sharing an engine do not collide. */
    idSuffix?: string;
  },
): Dispatch {
  const queueFor = (chosen: "stable" | "canary") =>
    chosen === "canary" ? (options.canaryTaskQueue ?? options.taskQueue) : options.taskQueue;
  const suffix = options.idSuffix ?? "";

  return async (job) => {
    try {
      if (job.kind === "ticket") {
        await client.workflow.start("ticketWorkflow", {
          args: [job.ref],
          taskQueue: queueFor(job.route),
          workflowId: ticketWorkflowId(job.ref.ticketId, suffix),
          // A ticket's first run happens once. If any run exists, this
          // start is a repeat, not new work.
          workflowIdReusePolicy: "REJECT_DUPLICATE",
        });
      } else if (job.kind === "follow_up") {
        await client.workflow.start("ticketWorkflow", {
          args: [job.ref, { followUp: job.messageId }],
          taskQueue: queueFor(job.route),
          workflowId: ticketWorkflowId(job.ref.ticketId, suffix),
        });
      } else {
        await client.workflow.start("deletionWorkflow", {
          args: [job.ref, { ticketWorkflowSuffix: suffix }],
          taskQueue: options.taskQueue,
          workflowId: deletionWorkflowId(job.ref.requestId, suffix),
          workflowIdReusePolicy: "REJECT_DUPLICATE",
        });
      }
      return "started";
    } catch (error) {
      if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
      // For a follow-up, a run with this id still open is the ticket's
      // previous run closing. For the others it is this same job.
      return job.kind === "follow_up" ? "busy" : "started";
    }
  };
}

/**
 * Tells which of the given workflows are still running. One that was asked
 * to stop counts as running until the step it was in has finished.
 */
export function runningWorkflows(client: Client) {
  return async (workflowIds: string[]): Promise<string[]> => {
    const states = await Promise.all(
      workflowIds.map(async (workflowId) => {
        try {
          const { status } = await client.workflow.getHandle(workflowId).describe();
          return status.name === "RUNNING";
        } catch (error) {
          // Never started: nothing ever ran under that id.
          if (error instanceof WorkflowNotFoundError) return false;
          throw error;
        }
      }),
    );
    return workflowIds.filter((_, index) => states[index]);
  };
}

/**
 * `delivered`: the ticket's workflow has the decision.
 * `closed`: no workflow is waiting for it any more. The ticket was finished,
 * stopped or deleted while the approval sat in the queue.
 */
export type ApprovalDelivery = (decision: {
  ticketId: string;
  approvalId: string;
  decision: "approved" | "rejected";
  decidedBy: string;
}) => Promise<"delivered" | "closed">;

/** Hands a member of staff's decision to the workflow that asked for it. */
export function createApprovalDelivery(
  client: Client,
  options: { idSuffix?: string } = {},
): ApprovalDelivery {
  return async ({ ticketId, ...decision }) => {
    try {
      await client.workflow
        .getHandle(ticketWorkflowId(ticketId, options.idSuffix))
        .signal("approvalDecided", decision);
      return "delivered";
    } catch (error) {
      if (error instanceof WorkflowNotFoundError) return "closed";
      throw error;
    }
  };
}
