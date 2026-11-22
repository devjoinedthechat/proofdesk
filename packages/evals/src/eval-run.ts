import { PROMPT_VERSION, type TenantPolicy } from "@proofdesk/agent";
import {
  type CallRecord,
  CLAUDE_FAILOVER,
  createFaultInjector,
  createGateway,
  createMemoryLedger,
  createRecordingProvider,
  type Effort,
  type ModelProvider,
  modelOutage,
  type PriceTable,
  type Recording,
} from "@proofdesk/gateway";
import type { ToolPolicy } from "@proofdesk/policy";
import {
  baseWorld,
  createDocumentsEnv,
  createSimEnv,
  materialise,
  REFUND_SCENARIOS,
  runScenario,
  type Scenario,
  type ScenarioSpec,
} from "@proofdesk/simulator";
import { createAgentSolver } from "./agent-solver.ts";

/** One attempt at one scenario. */
export type RunRecord = {
  scenario: string;
  repeat: number;
  passed: boolean;
  failures: string[];
  expected: { outcome: string; reasonCode: string };
  actual: { outcome: string; reasonCode: string; reply: string } | null;
  /** How the agent loop ended, before any guard turned it into a hand-over. */
  stopped: string;
  violations: string[];
  /** Money amounts in the reply that the agent was never shown. Measured, not enforced. */
  unsourcedAmounts?: string[];
  turns: number;
  toolCalls: { tool: string; verdict: string; failed: boolean; error?: string }[];
  /** Present for attack scenarios. */
  attack?: { class: string; technique: string; succeeded: boolean };
  modelCalls: number;
  /** Present for runs with an injected outage: model calls answered, by model. */
  answeredBy?: Record<string, number>;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costMicros: number;
  latencyMs: number;
  error?: string;
};

export type EvalResults = {
  label: string;
  model: string;
  effort: Effort | "default";
  prompt: string;
  /** The version of the production prompt text at the time of the run. */
  promptVersion: string;
  /** Which scenarios were run. */
  suite: string;
  /** Which policy set was enforced. */
  policy: string;
  /**
   * How the model was reached: the API, or the Claude Code command line.
   * Absent in files written before there were two ways, which all used the API.
   */
  via?: "api" | "claude-code";
  /** Present when calls to one model were made to fail, to exercise failover. */
  outage?: { model: string; rate: number; backup: string };
  startedAt: string;
  repeats: number;
  scenarios: number;
  /** True when the run stopped early because it reached its spend cap. */
  stoppedAtSpendCap: boolean;
  totalCostMicros: number;
  runs: RunRecord[];
};

export type EvalOptions = {
  label: string;
  postgresUrl: string;
  provider: ModelProvider;
  prices: PriceTable;
  model: string;
  effort?: Effort;
  repeats: number;
  concurrency: number;
  /** The whole run stops starting new attempts once this much is spent. */
  maxSpendMicros: number;
  /** The most one ticket may spend. */
  perTicketMicros?: number;
  scenarioIds?: string[];
  via?: "api" | "claude-code";
  /** The scenarios to run. Defaults to the refund suite. */
  suite?: { name: string; specs: ScenarioSpec[] };
  /** A different policy set, for measuring what the enforced rules are worth. */
  policy?: { name: string; policy: ToolPolicy };
  /** A different system prompt, for measuring what a prompt change does. */
  prompt?: { name: string; system: (policy: TenantPolicy) => string };
  /**
   * Makes a share of the calls to one model fail as overloaded, with failover
   * to another Claude model switched on. The failing calls are never sent.
   */
  outage?: { model: string; rate: number };
  /** Filled with every model response of repeat 1, for replay tests. */
  recordings?: Record<string, Recording>;
  onProgress?: (done: number, total: number, record: RunRecord) => void;
};

/**
 * Runs the agent on real scenarios with a real model and records, for every
 * attempt, whether the final state of the company was right, and what the
 * attempt cost in money, time and turns.
 */
export async function runEval(options: EvalOptions): Promise<EvalResults> {
  const scenarios: Scenario[] = (options.suite?.specs ?? REFUND_SCENARIOS)
    .filter((spec) => !options.scenarioIds || options.scenarioIds.includes(spec.id))
    .map((spec) => materialise(spec, baseWorld()));

  const jobs = scenarios.flatMap((scenario) =>
    Array.from({ length: options.repeats }, (_, index) => ({ scenario, repeat: index + 1 })),
  );
  // Repeats are interleaved, so an early stop still covers every scenario evenly.
  jobs.sort((a, b) => a.repeat - b.repeat);

  const runs: RunRecord[] = [];
  let spent = 0;
  let stoppedAtSpendCap = false;
  let next = 0;

  async function attempt(scenario: Scenario, repeat: number): Promise<RunRecord> {
    const calls: CallRecord[] = [];
    const recording: Recording = {};
    const recorded =
      repeat === 1 && options.recordings
        ? createRecordingProvider(options.provider, recording)
        : options.provider;
    const provider = options.outage
      ? createFaultInjector(recorded, modelOutage({ ...options.outage, seed: repeat }))
      : recorded;
    // A gateway per attempt: its ledger is this attempt's budget and nothing else.
    const gateway = createGateway({
      routes: options.outage
        ? [{ provider }, { provider, models: CLAUDE_FAILOVER }]
        : [{ provider }],
      // The injected failures are instant, so waiting between retries tests nothing.
      ...(options.outage ? { baseDelayMs: 1 } : {}),
      prices: options.prices,
      ledger: createMemoryLedger(),
      limits: {
        perTicketMicros: options.perTicketMicros ?? 500_000,
        perTenantMicros: options.perTicketMicros ?? 500_000,
      },
      onCall: (record) => calls.push(record),
    });

    const record: RunRecord = {
      scenario: scenario.id,
      repeat,
      passed: false,
      failures: [],
      expected: { outcome: scenario.expected.outcome, reasonCode: scenario.expected.reasonCode },
      actual: null,
      stopped: "error",
      violations: [],
      turns: 0,
      toolCalls: [],
      modelCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costMicros: 0,
      latencyMs: 0,
    };

    const solver = createAgentSolver({
      gateway,
      model: options.model,
      ...(options.effort ? { effort: options.effort } : {}),
      ...(options.prompt ? { system: options.prompt.system } : {}),
      ...(options.policy ? { policy: options.policy.policy } : {}),
      onResult(result, violations, unsourcedAmounts) {
        record.stopped = result.stopped;
        record.violations = violations;
        record.unsourcedAmounts = unsourcedAmounts;
        record.turns = result.turns;
        record.toolCalls = result.toolCalls.map((call) => ({
          tool: call.tool,
          verdict: call.verdict,
          failed: call.outcome.isError,
          ...(call.outcome.isError ? { error: call.outcome.content.slice(0, 160) } : {}),
        }));
      },
    });

    const started = Date.now();
    const env = await createSimEnv(options.postgresUrl);
    // Every attempt gets the help centre, as the agent has in production.
    const documents = await createDocumentsEnv(options.postgresUrl);
    try {
      const result = await runScenario(env, scenario, solver, { documents });
      record.passed = result.passed;
      record.failures = result.failures;
      record.actual = result.result ?? null;
      if (scenario.attack && result.attackSucceeded !== undefined) {
        record.attack = {
          class: scenario.attack.class,
          technique: scenario.attack.technique,
          succeeded: result.attackSucceeded,
        };
      }
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error);
      record.failures = [`run error: ${record.error}`];
    } finally {
      await documents.dispose();
      await env.dispose();
    }
    record.latencyMs = Date.now() - started;

    for (const call of calls) {
      if (!call.usage) continue;
      record.modelCalls += 1;
      if (options.outage) {
        record.answeredBy ??= {};
        record.answeredBy[call.sentModel] = (record.answeredBy[call.sentModel] ?? 0) + 1;
      }
      record.inputTokens += call.usage.inputTokens;
      record.outputTokens += call.usage.outputTokens;
      record.cacheReadTokens += call.usage.cacheReadTokens;
      record.cacheWriteTokens += call.usage.cacheWriteTokens;
      record.costMicros += call.costMicros ?? 0;
    }
    if (repeat === 1 && options.recordings) options.recordings[scenario.id] = recording;
    return record;
  }

  async function lane(): Promise<void> {
    for (;;) {
      const job = jobs[next++];
      if (!job) return;
      if (spent >= options.maxSpendMicros) {
        stoppedAtSpendCap = true;
        return;
      }
      const record = await attempt(job.scenario, job.repeat);
      spent += record.costMicros;
      runs.push(record);
      options.onProgress?.(runs.length, jobs.length, record);
    }
  }

  const startedAt = new Date().toISOString();
  await Promise.all(Array.from({ length: options.concurrency }, lane));
  runs.sort((a, b) => a.scenario.localeCompare(b.scenario) || a.repeat - b.repeat);

  return {
    label: options.label,
    model: options.model,
    effort: options.effort ?? "default",
    prompt: options.prompt?.name ?? "production",
    promptVersion: PROMPT_VERSION,
    suite: options.suite?.name ?? "refund",
    policy: options.policy?.name ?? "production",
    ...(options.via ? { via: options.via } : {}),
    ...(options.outage
      ? { outage: { ...options.outage, backup: CLAUDE_FAILOVER[options.outage.model] ?? "none" } }
      : {}),
    startedAt,
    repeats: options.repeats,
    scenarios: scenarios.length,
    stoppedAtSpendCap,
    totalCostMicros: spent,
    runs,
  };
}
