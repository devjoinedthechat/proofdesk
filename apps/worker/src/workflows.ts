// Workflow code. It must be deterministic: no I/O, no clock, no randomness.
// Everything that touches the world happens in an activity, and the engine
// replays this function from its history after a crash.

import {
  condition,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
} from "@temporalio/workflow";
import type { Activities, ApprovalAnswer, FinishOutput, TicketRef } from "./activities.ts";

const { startRun, executeNext, finishRun } = proxyActivities<Activities>({
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
    const turn = await modelTurn({ ref, step });
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
