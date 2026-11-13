import { describe, expect, it } from "vitest";
import { changePlan } from "./plan-change.ts";
import type { ToolOutcome } from "./tools.ts";

const ok = (value: unknown): ToolOutcome => ({ content: JSON.stringify(value), isError: false });
const refused = (code: string): ToolOutcome => ({
  content: JSON.stringify({ error: { code, message: code } }),
  isError: true,
});
const change = (status = "applied") => ({
  change: { id: "chg_1", status, to: { planCode: "team", seats: 5 } },
});

/** A scripted pair of services, recording every call made to them. */
function services(script: Record<string, ToolOutcome | Error>) {
  const calls: { tool: string; input: Record<string, unknown> }[] = [];
  return {
    calls,
    call: async (tool: string, input: Record<string, unknown>) => {
      calls.push({ tool, input });
      const answer = script[tool];
      if (!answer) throw new Error(`unexpected call to ${tool}`);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

const input = { subscriptionId: "sub_1", planCode: "team", seats: 5 };

describe("changePlan", () => {
  it("changes billing, then access, with one key on both", async () => {
    const { call, calls } = services({
      change_subscription: ok(change()),
      set_entitlement: ok({ entitlement: { planCode: "team", seats: 5, version: 2 } }),
    });

    const result = await changePlan(call, input, "key-1");

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toMatchObject({
      change: { id: "chg_1" },
      entitlement: { version: 2 },
    });
    expect(calls).toEqual([
      { tool: "change_subscription", input: { ...input, idempotencyKey: "key-1" } },
      { tool: "set_entitlement", input: { planCode: "team", seats: 5, idempotencyKey: "key-1" } },
    ]);
  });

  it("stops when billing refuses, having changed nothing", async () => {
    const { call, calls } = services({ change_subscription: refused("plan_not_available") });

    const result = await changePlan(call, input, "key-1");

    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain("plan_not_available");
    expect(calls).toHaveLength(1);
  });

  it("undoes the billing change when access cannot be updated", async () => {
    const { call, calls } = services({
      change_subscription: ok(change()),
      set_entitlement: refused("entitlement_suspended"),
      revert_subscription_change: ok(change("reverted")),
    });

    const result = await changePlan(call, input, "key-1");

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toMatchObject({ code: "plan_change_rolled_back" });
    expect(result.content).toContain("entitlement_suspended");
    expect(calls.at(-1)).toEqual({
      tool: "revert_subscription_change",
      input: { changeId: "chg_1" },
    });
  });

  it("does not undo anything when a step crashes, so that a retry can finish the job", async () => {
    const { call, calls } = services({
      change_subscription: ok(change()),
      set_entitlement: new Error("connection reset"),
    });

    await expect(changePlan(call, input, "key-1")).rejects.toThrow("connection reset");
    expect(calls.map((entry) => entry.tool)).toEqual(["change_subscription", "set_entitlement"]);
  });

  it("fails loudly when the undo itself is refused", async () => {
    const { call } = services({
      change_subscription: ok(change()),
      set_entitlement: refused("entitlement_suspended"),
      revert_subscription_change: refused("subscription_changed_since"),
    });

    await expect(changePlan(call, input, "key-1")).rejects.toThrow(/could not be undone/);
  });

  it("reports a rollback again, without redoing it, when run a second time", async () => {
    // Billing replays the change for the same key, now marked as reverted.
    const { call, calls } = services({ change_subscription: ok(change("reverted")) });

    const result = await changePlan(call, input, "key-1");

    expect(JSON.parse(result.content).error.code).toBe("plan_change_rolled_back");
    expect(calls).toHaveLength(1);
  });
});
