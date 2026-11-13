import { describe, expect, it } from "vitest";
import { assess, type HealthRow, type Thresholds } from "./watchdog.ts";

const thresholds: Thresholds = {
  minSample: 10,
  canaryExcessFailureRate: 0.2,
  guardStopsToPause: 5,
};
const row = (overrides: Partial<HealthRow>): HealthRow => ({
  tenantId: "ten_a",
  route: "stable",
  finished: 100,
  failed: 5,
  guard: 0,
  ...overrides,
});
const kinds = (rows: HealthRow[]) => assess(rows, thresholds).map((action) => action.kind);

describe("assess: the canary", () => {
  it("is left alone while it does about as well as the stable build", () => {
    expect(kinds([row({}), row({ route: "canary", finished: 20, failed: 2 })])).toEqual([]);
  });

  it("is rolled back when it fails clearly more often", () => {
    const actions = assess(
      [row({}), row({ route: "canary", finished: 20, failed: 8 })],
      thresholds,
    );
    expect(actions).toEqual([
      {
        kind: "rollback_canary",
        detail: { canaryFinished: 20, canaryFailed: 8, stableFinished: 100, stableFailed: 5 },
      },
    ]);
  });

  it("is not judged on a handful of tickets", () => {
    expect(kinds([row({}), row({ route: "canary", finished: 9, failed: 9 })])).toEqual([]);
    expect(kinds([row({}), row({ route: "canary", finished: 10, failed: 10 })])).toEqual([
      "rollback_canary",
    ]);
  });

  it("is compared with the stable build, so a bad hour for both rolls nothing back", () => {
    expect(
      kinds([row({ failed: 50 }), row({ route: "canary", finished: 20, failed: 12 })]),
    ).toEqual([]);
  });

  it("is judged across tenants, and against nothing when the stable build is idle", () => {
    expect(
      kinds([
        row({ route: "canary", tenantId: "ten_a", finished: 6, failed: 3 }),
        row({ route: "canary", tenantId: "ten_b", finished: 6, failed: 3 }),
      ]),
    ).toEqual(["rollback_canary"]);
  });
});

describe("assess: a tenant's agent", () => {
  it("is paused when the reply guard stopped enough of its replies", () => {
    expect(assess([row({ guard: 5 }), row({ tenantId: "ten_b", guard: 4 })], thresholds)).toEqual([
      { kind: "pause_agent", tenantId: "ten_a", detail: { finished: 100, guardStops: 5 } },
    ]);
  });

  it("is not paused for what a canary did: that is a reason to roll back, not to stop", () => {
    expect(kinds([row({}), row({ route: "canary", finished: 5, failed: 5, guard: 5 })])).toEqual(
      [],
    );
  });

  it("does nothing on no data", () => {
    expect(assess([], thresholds)).toEqual([]);
  });
});
