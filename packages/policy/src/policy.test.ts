import { describe, expect, it } from "vitest";
import {
  createToolPolicy,
  loadPolicies,
  policyAuthorizer,
  type ToolRequest,
  validatePolicies,
} from "./index.ts";

const policy = createToolPolicy();
const ticket = { id: "tkt_1", category: "refund", approvalLimitCents: 200_00 };

const refund = (overrides: Partial<ToolRequest> = {}): ToolRequest => ({
  tool: "create_refund",
  ticket,
  agentPaused: false,
  amountCents: 50_00,
  ticketRefundedCents: 0,
  ...overrides,
});

describe("the shipped policies", () => {
  it("are valid against the schema", () => {
    expect(validatePolicies()).toEqual([]);
  });

  it("are rejected when a policy refers to something the schema does not define", () => {
    const set = loadPolicies();
    set.policies.broken =
      'permit (principal, action == Action::"create_refund", resource) when { resource.vip };';
    expect(validatePolicies(set).length).toBeGreaterThan(0);
    expect(() => createToolPolicy(set)).toThrow(/Invalid policies/);
  });
});

describe("tool policy", () => {
  it("allows reads on billing tickets and denies them on others", () => {
    const read = (category: string) =>
      policy.decide({ tool: "list_invoices", ticket: { ...ticket, category }, agentPaused: false })
        .decision;

    expect(read("refund")).toBe("allow");
    expect(read("plan_change")).toBe("allow");
    expect(read("data_deletion")).toBe("deny");
  });

  it("allows a refund up to the limit and asks for approval above it", () => {
    expect(policy.decide(refund({ amountCents: 200_00 }))).toMatchObject({
      decision: "allow",
      policies: ["refund-within-limit"],
    });
    expect(policy.decide(refund({ amountCents: 200_01 }))).toMatchObject({
      decision: "needs_approval",
      policies: ["refund-with-approval"],
    });
  });

  it("applies the limit to the ticket's running total", () => {
    expect(
      policy.decide(refund({ amountCents: 100_00, ticketRefundedCents: 100_00 })).decision,
    ).toBe("allow");
    expect(
      policy.decide(refund({ amountCents: 100_00, ticketRefundedCents: 100_01 })).decision,
    ).toBe("needs_approval");
  });

  it("allows an over-limit refund once it is approved", () => {
    expect(policy.decide(refund({ amountCents: 980_00, approved: true }))).toMatchObject({
      decision: "allow",
      policies: ["refund-with-approval"],
    });
  });

  it("never allows a refund on a ticket of another category, approved or not", () => {
    const planChange = { ...ticket, category: "plan_change" };
    expect(policy.decide(refund({ ticket: planChange })).decision).toBe("deny");
    expect(policy.decide(refund({ ticket: planChange, approved: true })).decision).toBe("deny");
  });

  it("denies amounts that are not positive whole cents", () => {
    expect(policy.decide(refund({ amountCents: 0 })).decision).toBe("deny");
    expect(policy.decide(refund({ amountCents: -500 })).decision).toBe("deny");
    expect(policy.decide(refund({ amountCents: 10.5 })).decision).toBe("deny");
    expect(policy.decide(refund({ amountCents: Number.NaN })).decision).toBe("deny");
    expect(policy.decide(refund({ amountCents: -500, approved: true })).decision).toBe("deny");
  });

  it("denies everything while the agent is paused, and approval does not help", () => {
    expect(policy.decide({ tool: "list_invoices", ticket, agentPaused: true })).toMatchObject({
      decision: "deny",
      policies: ["agent-paused"],
    });
    expect(policy.decide(refund({ agentPaused: true })).decision).toBe("deny");
    expect(policy.decide(refund({ agentPaused: true, amountCents: 980_00 })).decision).toBe("deny");
    expect(policy.decide(refund({ agentPaused: true, approved: true })).decision).toBe("deny");
  });

  it("denies a tool that no policy mentions", () => {
    expect(policy.decide({ tool: "delete_customer", ticket, agentPaused: false })).toMatchObject({
      decision: "deny",
      policies: [],
    });
  });
});

describe("policyAuthorizer", () => {
  const paid = (id: string, amountCents: number) => ({
    tool: "create_refund",
    input: {},
    verdict: "allow" as const,
    outcome: { content: JSON.stringify({ refund: { id, amountCents } }), isError: false },
  });

  it("counts what the ticket already refunded from the run's tool results", async () => {
    const authorize = policyAuthorizer(policy, { ticket });
    const call = { tool: "create_refund", input: { amountCents: 150_00 } };

    expect(await authorize(call, [])).toEqual({ decision: "allow" });
    expect(await authorize(call, [paid("ref_1", 50_00)])).toEqual({ decision: "allow" });
    expect(await authorize(call, [paid("ref_1", 50_01)])).toMatchObject({
      decision: "needs_approval",
    });
    // The same refund reported twice is one refund.
    expect(await authorize(call, [paid("ref_1", 50_00), paid("ref_1", 50_00)])).toEqual({
      decision: "allow",
    });
  });

  it("reads the kill switch at the moment of each call", async () => {
    let paused = false;
    const authorize = policyAuthorizer(policy, { ticket, agentPaused: () => paused });
    const call = { tool: "list_invoices", input: {} };

    expect(await authorize(call, [])).toEqual({ decision: "allow" });
    paused = true;
    expect(await authorize(call, [])).toMatchObject({ decision: "deny" });
  });
});
