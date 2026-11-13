import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { ANTHROPIC_PRICES, createAnthropicProvider, type Effort } from "@proofdesk/gateway";
import { prepareTemplates } from "@proofdesk/simulator";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
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

const postgres = await new PostgreSqlContainer("pgvector/pgvector:0.8.7-pg17").start();
try {
  await prepareTemplates(postgres.getConnectionUri());
  const recordings = values.record ? {} : undefined;

  const results = await runEval({
    label: values.label ?? model,
    postgresUrl: postgres.getConnectionUri(),
    provider: createAnthropicProvider(),
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
    onProgress(done, total, record) {
      const mark = record.passed ? "pass" : "FAIL";
      const cost = (record.costMicros / 1_000_000).toFixed(4);
      console.log(
        `[${done}/${total}] ${mark} ${record.scenario} #${record.repeat} $${cost} ${record.latencyMs}ms ${record.passed ? "" : record.failures[0]}`,
      );
    },
  });

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
  await postgres.stop();
}
