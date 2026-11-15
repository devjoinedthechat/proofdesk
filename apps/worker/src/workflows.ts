// Workflow code. It must be deterministic: no I/O, no clock, no randomness.
// Everything that touches the world happens in an activity, and the engine
// replays this function from its history after a crash.

import {
  ActivityCancellationType,
  ActivityFailure,
  ApplicationFailure,
  condition,
  continueAsNew,
  defineQuery,
  defineSignal,
  getExternalWorkflowHandle,
  patched,
  proxyActivities,
  setHandler,
  sleep,
} from "@temporalio/workflow";
import type {
  Activities,
  ApprovalAnswer,
  FinishOutput,
  TicketRef,
  TurnOutput,
} from "./activities.ts";
import type { DeletionActivities, DeletionRef, DeletionReport } from "./deletion.ts";
import type { WatchdogActivities } from "./watchdog.ts";

// When a ticket's workflow is cancelled, it does not close until the step
// that is running has stopped. A deletion cancels the customer's tickets and
// then erases; a workflow that closed at once would leave a tool call still
// writing while the erasing went on.
const cancellationType = ActivityCancellationType.WAIT_CANCELLATION_COMPLETED;

const { startRun, executeNext, finishRun, stopRun, resumeRun } = proxyActivities<Activities>({
  cancellationType,
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
  cancellationType,
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
export async function ticketWorkflow(
  ref: TicketRef,
  options: { followUp?: string } = {},
): Promise<FinishOutput> {
  const answers = new Map<string, ApprovalAnswer>();
  const status: TicketProgress = { phase: "starting", step: 0 };
  setHandler(progress, () => ({ ...status }));
  setHandler(approvalDecided, ({ approvalId, ...answer }) => {
    // The first answer for an approval stands.
    if (!answers.has(approvalId)) answers.set(approvalId, answer);
  });

  let step = 0;
  if (options.followUp) {
    // The customer answered a question. The same conversation carries on
    // from where it stopped. If this message was already taken in, by an
    // earlier start of this same work, there is nothing left to do.
    const resumed = await resumeRun({ ref, messageId: options.followUp });
    if (!resumed.resumed) return finishRun(ref);
    step = resumed.step;
  } else {
    await startRun(ref);
  }

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

const {
  beginDeletion,
  agentsStopped,
  eraseConversations,
  eraseElsewhere,
  eraseRecords,
  eraseIdentity,
  finishDeletion,
} = proxyActivities<DeletionActivities>({
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
 * 1. Stop any agent still working for the customer, and wait until it has.
 * 2. Remove their conversations from the inspection store.
 * 3. Close the billing account and remove access, on the request's own grant.
 * 4. Erase this system's records, which also removes that grant.
 * 5. Remove the sign-in account.
 *
 * Step 3 comes before 4 because it needs the grant, and 5 comes last because
 * a token for step 3 can only be issued for an account that still exists.
 */
export async function deletionWorkflow(
  ref: DeletionRef,
  options: { ticketWorkflowSuffix?: string } = {},
): Promise<DeletionReport> {
  const { openTicketIds, ticketIds } = await beginDeletion(ref);
  const agents = openTicketIds.map((ticketId) =>
    ticketWorkflowId(ticketId, options.ticketWorkflowSuffix),
  );
  for (const workflowId of agents) {
    try {
      await getExternalWorkflowHandle(workflowId).cancel();
    } catch {
      // Already finished, or never started. Either way no agent is running.
    }
  }
  // Asking an agent to stop is not the same as it having stopped: a tool
  // call under way finishes first. Nothing is erased until every one has.
  if (patched("wait-for-agents")) await agentsStopped({ workflowIds: agents });
  // After the agents have stopped, so that no conversation is still being
  // written. A request that was already running when this step was added
  // carries on without it, as it was started.
  const conversations = patched("erase-conversations")
    ? await eraseConversations({ ref, ticketIds })
    : 0;
  const elsewhere = await eraseElsewhere(ref);
  const records = await eraseRecords(ref);
  const signInAccounts = await eraseIdentity(ref);
  const report: DeletionReport = { ...elsewhere, records, signInAccounts, conversations };
  await finishDeletion({ ref, report });
  return report;
}

const { watch, dispatchPending } = proxyActivities<WatchdogActivities>({
  startToCloseTimeout: "1 minute",
  heartbeatTimeout: "10 seconds",
  retry: { initialInterval: "1 second", backoffCoefficient: 2, maximumInterval: "1 minute" },
});

/**
 * Checks on the agent at a fixed interval, for as long as the system runs.
 * It starts afresh every so often so that its history stays short.
 */
export async function watchdogWorkflow(
  options: { intervalSeconds?: number; rounds?: number } = {},
): Promise<void> {
  const rounds = options.rounds ?? 60;
  for (let round = 0; round < rounds; round++) {
    await watch();
    // Added after watchdogs were already running. One that started before
    // replays its history without this step, and takes it up from then on.
    if (patched("sweep-outbox")) await dispatchPending();
    await sleep((options.intervalSeconds ?? 60) * 1000);
  }
  await continueAsNew<typeof watchdogWorkflow>(options);
}
