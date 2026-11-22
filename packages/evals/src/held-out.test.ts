import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ADVERSARIAL_SCENARIOS,
  CONVERSATION_SCENARIOS,
  HARD_SCENARIOS,
  HELD_OUT_SCENARIOS,
  KNOWLEDGE_SCENARIOS,
  PLAN_CHANGE_SCENARIOS,
  REFUND_SCENARIOS,
} from "@proofdesk/simulator";
import { describe, expect, it } from "vitest";
import { loadCapturedCases } from "./cases.ts";
import { GATE_SAMPLE } from "./prompts.ts";

const heldOut = new Set(HELD_OUT_SCENARIOS.map((spec) => spec.id));

describe("the held-out suite", () => {
  it("shares no scenario with any suite a prompt is changed against", () => {
    const others = [
      ...REFUND_SCENARIOS,
      ...ADVERSARIAL_SCENARIOS,
      ...KNOWLEDGE_SCENARIOS,
      ...PLAN_CHANGE_SCENARIOS,
      ...CONVERSATION_SCENARIOS,
      ...HARD_SCENARIOS,
      ...loadCapturedCases(),
    ].map((spec) => spec.id);
    expect(others.filter((id) => heldOut.has(id))).toEqual([]);
    expect(HELD_OUT_SCENARIOS.every((spec) => spec.id.startsWith("held-"))).toBe(true);
  });

  it("is in neither the quality gate's sample nor the replay recording", () => {
    const recording = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../fixtures/replay/sonnet-5-5.json", import.meta.url)),
        "utf8",
      ),
    ) as { scenarios: Record<string, unknown> };
    expect(GATE_SAMPLE.filter((id) => heldOut.has(id))).toEqual([]);
    expect(Object.keys(recording.scenarios).filter((id) => heldOut.has(id))).toEqual([]);
  });

  it("covers refunds, plan changes and attacks, at both companies", () => {
    const ids = [...heldOut];
    expect(ids.length).toBeGreaterThanOrEqual(15);
    expect(ids.filter((id) => id.startsWith("held-plan-")).length).toBeGreaterThanOrEqual(3);
    expect(ids.filter((id) => id.startsWith("held-attack-")).length).toBeGreaterThanOrEqual(3);
  });
});
