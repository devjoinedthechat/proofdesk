import { describe, expect, it } from "vitest";
import type { EvalResults, RunRecord } from "./eval-run.ts";
import { buildReport, classify } from "./report.ts";

const run = (overrides: Partial<RunRecord> = {}): RunRecord => ({
  scenario: "refund-a",
  repeat: 1,
  passed: true,
  failures: [],
  expected: { outcome: "refunded", reasonCode: "within_window" },
  actual: { outcome: "refunded", reasonCode: "within_window", reply: "ok" },
  stopped: "resolved",
  violations: [],
  turns: 3,
  toolCalls: [],
  modelCalls: 3,
  inputTokens: 1000,
  outputTokens: 100,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costMicros: 10_000,
  latencyMs: 4000,
  ...overrides,
});

const failed = (failures: string[], actual?: RunRecord["actual"]) =>
  run({ passed: false, failures, ...(actual ? { actual } : {}) });

describe("classify", () => {
  it("returns nothing for a pass", () => {
    expect(classify(run())).toBeNull();
  });

  it("ranks a wrong refund above every other difference", () => {
    expect(
      classify(
        failed([
          "outcome: expected refused, got refunded",
          "refunds: expected [], got [pay_1 500]",
        ]),
      ),
    ).toBe("wrong_money");
  });

  it("separates a wrong outcome from a wrong reason and a reply problem", () => {
    expect(
      classify(
        failed(["outcome: expected refused, got handed_to_staff", "reason: expected a, got b"]),
      ),
    ).toBe("wrong_outcome");
    expect(classify(failed(["reason: expected outside_window, got other"]))).toBe("wrong_reason");
    expect(classify(failed(['reply does not mention "INV-1"']))).toBe("reply");
  });

  it("recognises runs the agent or the guard ended", () => {
    const handed = (reasonCode: string) => ({ outcome: "handed_to_staff", reasonCode, reply: "" });
    expect(
      classify(
        failed(["outcome: expected refunded, got handed_to_staff"], handed("agent_turn_limit")),
      ),
    ).toBe("did_not_finish");
    expect(
      classify(
        failed(
          ["outcome: expected refunded, got handed_to_staff"],
          handed("guard_claims_refund_not_made"),
        ),
      ),
    ).toBe("guard_stopped");
  });
});

describe("buildReport", () => {
  it("summarises pass rate, cost and consistency per run", () => {
    const results: EvalResults = {
      label: "sample",
      model: "m",
      effort: "medium",
      prompt: "production",
      startedAt: "2026-01-01T00:00:00.000Z",
      repeats: 2,
      scenarios: 2,
      stoppedAtSpendCap: false,
      totalCostMicros: 40_000,
      runs: [
        run({ scenario: "refund-a", repeat: 1 }),
        run({ scenario: "refund-a", repeat: 2 }),
        run({ scenario: "refund-b", repeat: 1 }),
        run({
          scenario: "refund-b",
          repeat: 2,
          passed: false,
          failures: ["reason: expected x, got y"],
        }),
      ],
    };

    const report = buildReport([results]);

    expect(report).toContain(
      "| sample | `m` | medium | production | 4 | 3 (75.0%) | 100.0%, 50.0% | $0.0100 / $0.0100 |",
    );
    expect(report).toContain("| sample | 1 | 1 | 0 |");
    expect(report).toContain("| `refund-b` | 1/2 |");
    expect(report).toContain("| sample | `refund-b` | 2 | wrong_reason |");
  });
});
