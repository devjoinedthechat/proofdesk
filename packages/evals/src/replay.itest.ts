import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { testPostgresUrl } from "@proofdesk/db";
import { createReplayProvider } from "@proofdesk/gateway";
import {
  baseWorld,
  createDocumentsEnv,
  createSimEnv,
  materialise,
  REFUND_SCENARIOS,
  runScenario,
} from "@proofdesk/simulator";
import { describe, expect, it } from "vitest";
import { createAgentSolver } from "./agent-solver.ts";
import { PROMPT_VARIANTS } from "./prompts.ts";
import type { ReplayFixture } from "./replay-fixture.ts";

// Replays a recorded real-model run. No model is called, so this is free and
// gives the same answer every time. It protects two things on every change:
//
// 1. The code around the model. With the model's responses held fixed, each
//    scenario must end exactly as it did when the recording was made.
// 2. The recording's validity. Any change to the prompt, the tool
//    descriptions or the conversation format changes the requests, the replay
//    finds no recorded answer, and the test fails. The fix is to run the real
//    evaluation again, which is the point.

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../fixtures/replay/sonnet-5-5.json", import.meta.url)),
    "utf8",
  ),
) as ReplayFixture;
const effort = fixture.effort === "default" ? {} : { effort: fixture.effort };

const scenarios = REFUND_SCENARIOS.map((spec) => materialise(spec, baseWorld()));

async function replay(id: string, options: { prompt?: keyof typeof PROMPT_VARIANTS } = {}) {
  const scenario = scenarios.find((candidate) => candidate.id === id);
  const recorded = fixture.scenarios[id];
  if (!scenario || !recorded) throw new Error(`No recording for ${id}`);
  const system = options.prompt ? PROMPT_VARIANTS[options.prompt] : undefined;

  const env = await createSimEnv(testPostgresUrl());
  const documents = await createDocumentsEnv(testPostgresUrl());
  try {
    return await runScenario(
      env,
      scenario,
      createAgentSolver({
        gateway: createReplayProvider(recorded.recording),
        model: fixture.model,
        ...effort,
        ...(system ? { system } : {}),
      }),
      { documents },
    );
  } finally {
    await documents.dispose();
    await env.dispose();
  }
}

describe("replay of a recorded real-model run", () => {
  it("has a recording for every scenario", () => {
    expect(Object.keys(fixture.scenarios).sort()).toEqual(
      scenarios.map((scenario) => scenario.id).sort(),
    );
  });

  describe.concurrent("each scenario ends as it did when recorded", () => {
    it.for(scenarios.map((scenario) => scenario.id))("%s", async (id) => {
      const recorded = fixture.scenarios[id];
      const result = await replay(id);

      expect(result.failures.filter((failure) => failure.includes("No recorded response"))).toEqual(
        [],
      );
      expect({
        passed: result.passed,
        outcome: result.result?.outcome ?? null,
        reasonCode: result.result?.reasonCode ?? null,
      }).toEqual({
        passed: recorded?.passed,
        outcome: recorded?.outcome,
        reasonCode: recorded?.reasonCode,
      });
    });
  });

  it("refuses to answer once the prompt has changed", async () => {
    const result = await replay("refund-within-window", { prompt: "no-policy" });

    expect(result.passed).toBe(false);
    expect(result.failures.join(" ")).toContain("No recorded response");
  });
});
