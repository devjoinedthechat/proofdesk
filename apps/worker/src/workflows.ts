// Workflow code. It must be deterministic: no I/O, no clock, no randomness.
// Everything that touches the world happens in an activity, and the engine
// replays this function from its history after a crash.

import {
  ActivityFailure,
  ApplicationFailure,
  condition,
  defineQuery,
  defineSignal,
  getExternalWorkflowHandle,
  proxyActivities,
  setHandler,
} from "@temporalio/workflow";
import type {
  Activities,
  ApprovalAnswer,
  FinishOutput,
  TicketRef,
  TurnOutput,
} from "./activities.ts";
import type { DeletionActivities, DeletionRef, DeletionReport } from "./deletion.ts";

const { startRun, executeNext, finishRun, stopRun } = proxyActivities<Activities>({
  startToCloseTimeout: "2 minutes",
  // Activities report in every few seconds. A worker that goes silent is
  // presumed lost and its activity is given to another, long before the
  // overall timeout.
  heartbeatTimeout: "10 seconds",
  retry: { initialInterval: "1 second", backoffCoefficient: 2, maximumInterval: "1 minute" },
});

// A model call may think for a long time, and each attempt costs money, so
// its attempts are capped. The gateway inside already retries transient
// provider failures.
const { modelTurn } = proxyActivities<Activities>({
  startToCloseTimeout: "10 minutes",
  heartbeatTimeout: "30 seconds",
  retry: { initialInterval: "5 seconds", backoffCoefficient: 2, maximumAttempts: 4 },
});

/** True when an activity failed because the model provider did, and for no other reason. */
const isModelFailure = (error: unknown) =>
  error instanceof ActivityFailure &&
  error.cause instanceof ApplicationFailure &&
  error.cause.type === "ProviderError";

export const approvalDecided =
  defineSignal<[{ approvalId: string } & ApprovalAnswer]>("approvalDecided");

export type TicketProgress = {
  phase: "starting" | "thinking" | "acting" | "waiting_approval" | "finishing" | "done";
  step: number;
  approvalId?: string;
};

export const progress = defineQuery<TicketProgress>("progress");

/** How long a refund waits for staff before it counts as declined. */
const APPROVAL_TIMEOUT = "7 days";

/**
 * One ticket, from arrival to reply. The function is a plain loop, and the
 * engine makes it durable: a worker can die at any line and another picks up
 * at the same point, however long the wait for an approval was.
 *
 * Only identifiers and step numbers pass through here. The conversation is in
 * the database, so nothing personal ends up in the workflow history.
 */
export async function ticketWorkflow(ref: TicketRef): Promise<FinishOutput> {
  const answers = new Map<string, ApprovalAnswer>();
  const status: TicketProgress = { phase: "starting", step: 0 };
  setHandler(progress, () => ({ ...status }));
  setHandler(approvalDecided, ({ approvalId, ...answer }) => {
    // The first answer for an approval stands.
    if (!answers.has(approvalId)) answers.set(approvalId, answer);
  });

  await startRun(ref);

  let step = 0;
  let stopped = false;
  while (!stopped) {
    status.phase = "thinking";
    status.step = step;
    let turn: TurnOutput;
    try {
      turn = await modelTurn({ ref, step });
    } catch (error) {
      // The model could not be reached after the gateway's retries, its
      // failover and this activity's own attempts. A person takes the ticket.
      // Any other failure is a fault in this system and stays loud.
      if (!isModelFailure(error)) throw error;
      await stopRun({ ref, step });
      break;
    }
    step += 1;
    stopped = turn.stopped;

    let pending = turn.pending;
    while (pending > 0) {
      status.phase = "acting";
      status.step = step;
      let result = await executeNext({ ref, step });

      if (result.status === "needs_approval") {
        const { approvalId } = result;
        status.phase = "waiting_approval";
        status.approvalId = approvalId;
        await condition(() => answers.has(approvalId), APPROVAL_TIMEOUT);
        const approval = answers.get(approvalId) ?? {
          decision: "rejected" as const,
          decidedBy: "system:approval-timeout",
        };
        delete status.approvalId;
        status.phase = "acting";
        result = await executeNext({ ref, step, approval });
      }
      if (result.status !== "done") throw new Error("A tool call was left unsettled");

      step += 1;
      pending = result.pending;
      stopped = result.stopped;
    }
  }

  status.phase = "finishing";
  const outcome = await finishRun(ref);
  status.phase = "done";
  return outcome;
}

const { beginDeletion, eraseElsewhere, eraseRecords, eraseIdentity, finishDeletion } =
  proxyActivities<DeletionActivities>({
    startToCloseTimeout: "2 minutes",
    heartbeatTimeout: "10 seconds",
    retry: { initialInterval: "1 second", backoffCoefficient: 2, maximumInterval: "1 minute" },
  });

/** The workflow id of a ticket. `suffix` exists so tests can run side by side. */
const ticketWorkflowId = (ticketId: string, suffix = "") => `ticket-${ticketId}${suffix}`;

/**
 * Deletes one customer's data at their request. There is no model in this
 * workflow and no decision: the steps and their order are fixed.
 *
 * 1. Stop any agent still working for the customer.
 * 2. Close the billing account and remove access, on the request's own grant.
 * 3. Erase this system's records, which also removes that grant.
 * 4. Remove the sign-in account.
 *
 * Steps 2 comes before 3 because it needs the grant, and 4 comes last because
 * a token for step 2 can only be issued for an account that still exists.
 */
export async function deletionWorkflow(
  ref: DeletionRef,
  options: { ticketWorkflowSuffix?: string } = {},
): Promise<DeletionReport> {
  const { openTicketIds } = await beginDeletion(ref);
  for (const ticketId of openTicketIds) {
    try {
      await getExternalWorkflowHandle(
        ticketWorkflowId(ticketId, options.ticketWorkflowSuffix),
      ).cancel();
    } catch {
      // Already finished, or never started. Either way no agent is running.
    }
  }
  const elsewhere = await eraseElsewhere(ref);
  const records = await eraseRecords(ref);
  const signInAccounts = await eraseIdentity(ref);
  const report: DeletionReport = { ...elsewhere, records, signInAccounts };
  await finishDeletion({ ref, report });
  return report;
}
