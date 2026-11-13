import type { Effort, Recording } from "@proofdesk/gateway";
import type { EvalResults } from "./eval-run.ts";

/**
 * One recorded pass over the scenarios: every model response, and what each
 * scenario's result was. Replaying it needs no model and costs nothing.
 */
export type ReplayFixture = {
  model: string;
  effort: Effort | "default";
  recordedAt: string;
  scenarios: Record<
    string,
    { passed: boolean; outcome: string | null; reasonCode: string | null; recording: Recording }
  >;
};

export function toReplayFixture(
  results: EvalResults,
  recordings: Record<string, Recording>,
): ReplayFixture {
  const scenarios: ReplayFixture["scenarios"] = {};
  for (const run of results.runs) {
    const recording = recordings[run.scenario];
    if (run.repeat !== 1 || !recording) continue;
    scenarios[run.scenario] = {
      passed: run.passed,
      outcome: run.actual?.outcome ?? null,
      reasonCode: run.actual?.reasonCode ?? null,
      recording,
    };
  }
  return { model: results.model, effort: results.effort, recordedAt: results.startedAt, scenarios };
}
