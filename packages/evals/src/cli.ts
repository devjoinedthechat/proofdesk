import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { ANTHROPIC_PRICES, createAnthropicProvider, type Effort } from "@proofdesk/gateway";
import {
  createToolPolicy,
  loadPolicies,
  RECORD_BASED_POLICIES,
  type ToolPolicy,
} from "@proofdesk/policy";
import {
  ADVERSARIAL_SCENARIOS,
  CONVERSATION_SCENARIOS,
  KNOWLEDGE_SCENARIOS,
  PLAN_CHANGE_SCENARIOS,
  prepareTemplates,
  REFUND_SCENARIOS,
  type ScenarioSpec,
} from "@proofdesk/simulator";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { loadCapturedCases } from "./cases.ts";
import { createClaudeCodeProvider } from "./claude-code-provider.ts";
import { runEval } from "./eval-run.ts";
import { GATE_SAMPLE, PROMPT_VARIANTS } from "./prompts.ts";
import { toReplayFixture } from "./replay-fixture.ts";

// Runs the agent on the scenario suite with a real model. This spends money.
//
//   pnpm evals --model claude-sonnet-5-5 --repeats 3 --max-spend 3.00 --out docs/eval-report/data/sonnet.json
//   pnpm evals --model claude-sonnet-5-5 --scenarios gate --min-pass-rate 0.9 --max-spend 0.50 --out /tmp/gate.json
//
// It needs Docker (for a throwaway Postgres) and ANTHROPIC_API_KEY, which is
// read from .env when present.

const { values } = parseArgs({
  options: {
    model: { type: "string" },
    label: { type: "string" },
    effort: { type: "string" },
    repeats: { type: "string", default: "1" },
    concurrency: { type: "string", default: "4" },
    "max-spend": { type: "string" },
    scenarios: { type: "string" },
    prompt: { type: "string" },
    out: { type: "string" },
    record: { type: "string" },
    "min-pass-rate": { type: "string" },
    suite: { type: "string", default: "refund" },
    policy: { type: "string", default: "production" },
    outage: { type: "string" },
    via: { type: "string", default: "api" },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const model = values.model ?? fail("--model is required");
const maxSpend = Number(values["max-spend"] ?? fail("--max-spend (in dollars) is required"));
const out = values.out ?? fail("--out is required");
if (!(maxSpend > 0)) fail("--max-spend must be a positive number of dollars");
const promptName = values.prompt;
const promptSystem = promptName ? PROMPT_VARIANTS[promptName] : undefined;
if (promptName && !promptSystem) fail(`Unknown prompt "${promptName}"`);

const SUITES: Record<string, ScenarioSpec[]> = {
  refund: REFUND_SCENARIOS,
  adversarial: ADVERSARIAL_SCENARIOS,
  knowledge: KNOWLEDGE_SCENARIOS,
  plan: PLAN_CHANGE_SCENARIOS,
  // Tickets that take more than one round, and attacks that arrive in an answer.
  conversation: CONVERSATION_SCENARIOS,
  // Cases captured from tickets the agent got wrong and staff reviewed.
  captured: loadCapturedCases(),
};
const suiteName = values.suite ?? "refund";
const suiteSpecs = SUITES[suiteName] ?? fail(`Unknown suite "${suiteName}"`);

// "prompt-only" drops the rules enforced on billing records, leaving them to
// the model's prompt alone. It exists to measure what that enforcement is worth.
const POLICIES: Record<string, () => ToolPolicy> = {
  production: () => createToolPolicy(),
  "prompt-only": () => createToolPolicy(loadPolicies({ exclude: RECORD_BASED_POLICIES })),
};
const policyName = values.policy ?? "production";
const buildPolicy = POLICIES[policyName] ?? fail(`Unknown policy "${policyName}"`);

// "--outage claude-sonnet-5-5:0.4" makes 40% of the calls to that model fail
// as overloaded, so those turns are answered by its backup model instead.
const [outageModel, outageRate] = values.outage?.split(":") ?? [];
const outage =
  outageModel && Number(outageRate) > 0 && Number(outageRate) <= 1
    ? { model: outageModel, rate: Number(outageRate) }
    : values.outage
      ? fail("--outage takes a model and a share, such as claude-sonnet-5-5:0.4")
      : undefined;

// "--via claude-code" reaches the model through the Claude Code command line,
// which signs in by itself, so the run needs no API key. The results file
// says which way was used: the two are not the same measurement.
if (values.via !== "api" && values.via !== "claude-code") fail(`Unknown --via "${values.via}"`);
const claudeCode = values.via === "claude-code" ? await createClaudeCodeProvider() : undefined;

const postgres = await new PostgreSqlContainer("pgvector/pgvector:0.8.7-pg17").start();
try {
  await prepareTemplates(postgres.getConnectionUri());
  const recordings = values.record ? {} : undefined;

  const results = await runEval({
    label: values.label ?? model,
    postgresUrl: postgres.getConnectionUri(),
    provider: claudeCode ?? createAnthropicProvider(),
    via: claudeCode ? "claude-code" : "api",
    prices: ANTHROPIC_PRICES,
    model,
    repeats: Number(values.repeats),
    concurrency: Number(values.concurrency),
    maxSpendMicros: Math.round(maxSpend * 1_000_000),
    ...(values.effort ? { effort: values.effort as Effort } : {}),
    ...(values.scenarios
      ? { scenarioIds: values.scenarios === "gate" ? GATE_SAMPLE : values.scenarios.split(",") }
      : {}),
    ...(promptName && promptSystem ? { prompt: { name: promptName, system: promptSystem } } : {}),
    ...(recordings ? { recordings } : {}),
    ...(outage ? { outage } : {}),
    suite: { name: suiteName, specs: suiteSpecs },
    policy: { name: policyName, policy: buildPolicy() },
    onProgress(done, total, record) {
      const mark = `${record.passed ? "pass" : "FAIL"}${record.attack?.succeeded ? " ATTACK-SUCCEEDED" : ""}`;
      const cost = (record.costMicros / 1_000_000).toFixed(4);
      console.log(
        `[${done}/${total}] ${mark} ${record.scenario} #${record.repeat} $${cost} ${record.latencyMs}ms ${record.passed ? "" : record.failures[0]}`,
      );
    },
  });

  // Through the command line the token counts are its own, with whatever
  // it adds around the prompt, and nothing is billed per token. They are
  // used for the spend cap during the run and left out of the file.
  if (claudeCode) {
    results.totalCostMicros = 0;
    for (const run of results.runs) {
      Object.assign(run, {
        costMicros: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
    }
  }

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
  if (values.record && recordings) {
    mkdirSync(dirname(values.record), { recursive: true });
    writeFileSync(
      values.record,
      `${JSON.stringify(toReplayFixture(results, recordings), null, 2)}\n`,
    );
  }

  const passed = results.runs.filter((run) => run.passed).length;
  console.log(
    `\n${passed}/${results.runs.length} attempts passed, $${(results.totalCostMicros / 1_000_000).toFixed(2)} spent${results.stoppedAtSpendCap ? " (stopped at the spend cap)" : ""}. Wrote ${out}`,
  );

  // The quality gate: a pass rate below the floor fails the command, which
  // fails the pipeline that ran it.
  const floor = values["min-pass-rate"] ? Number(values["min-pass-rate"]) : undefined;
  if (floor !== undefined) {
    const rate = passed / results.runs.length;
    const verdict = rate >= floor && !results.stoppedAtSpendCap ? "passed" : "FAILED";
    console.log(
      `Quality gate ${verdict}: pass rate ${(rate * 100).toFixed(1)}%, floor ${(floor * 100).toFixed(1)}%`,
    );
    if (verdict === "FAILED") process.exitCode = 1;
  }
} finally {
  await claudeCode?.close();
  await postgres.stop();
}
