import { describe, expect, it } from "vitest";
import {
  createToolPolicy,
  type InvoiceRecords,
  loadPolicies,
  policyAuthorizer,
  RECORD_BASED_POLICIES,
  type RefundFacts,
  refundFacts,
  type ToolRequest,
  validatePolicies,
} from "./index.ts";

const policy = createToolPolicy();
const ticket = {
  id: "tkt_1",
  category: "refund",
  approvalLimitCents: 200_00,
  refundWindowDays: 14,
};
const NOW = new Date("2026-03-15T10:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

const facts = (overrides: Partial<RefundFacts> = {}): RefundFacts => ({
  paymentFound: true,
  daysSincePayment: 3,
  paymentAmountCents: 50_00,
  isLaterDuplicate: false,
  invoiceDisputed: false,
  goodwillUsed: false,
  ...overrides,
});

type RefundOverrides = Partial<NonNullable<ToolRequest["refund"]>> & {
  ticket?: ToolRequest["ticket"];
  agentPaused?: boolean;
};

function refund(overrides: RefundOverrides = {}): ToolRequest {
  const { ticket: ticketOverride, agentPaused, ...rest } = overrides;
  return {
    tool: "create_refund",
    ticket: ticketOverride ?? ticket,
    agentPaused: agentPaused ?? false,
    refund: {
      amountCents: 50_00,
      reason: "customer_request",
      ticketRefundedCents: 0,
      approved: false,
      facts: facts(),
      ...rest,
    },
  };
}

const decide = (overrides: RefundOverrides = {}) => policy.decide(refund(overrides));

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

describe("reads and unknown tools", () => {
  it("allows reads on billing tickets and denies them on others", () => {
    const read = (category: string) =>
      policy.decide({ tool: "list_invoices", ticket: { ...ticket, category }, agentPaused: false })
        .decision;

    expect(read("refund")).toBe("allow");
    expect(read("plan_change")).toBe("allow");
    expect(read("data_deletion")).toBe("deny");
  });

  it("denies a tool that no policy mentions", () => {
    expect(policy.decide({ tool: "delete_customer", ticket, agentPaused: false })).toMatchObject({
      decision: "deny",
      policies: [],
    });
  });
});

describe("the amount limit", () => {
  it("allows a refund up to the limit and asks for approval above it", () => {
    expect(decide({ amountCents: 200_00 }).decision).toBe("allow");
    expect(decide({ amountCents: 200_01 })).toMatchObject({
      decision: "needs_approval",
      policies: ["refund-over-limit"],
    });
  });

  it("applies to the ticket's running total, so a refund cannot be split to stay under it", () => {
    expect(decide({ amountCents: 100_00, ticketRefundedCents: 100_00 }).decision).toBe("allow");
    expect(decide({ amountCents: 100_00, ticketRefundedCents: 100_01 }).decision).toBe(
      "needs_approval",
    );
    expect(decide({ amountCents: 1, ticketRefundedCents: 200_00 }).decision).toBe("needs_approval");
  });

  it("needs approval for any part of a payment that is larger than the limit", () => {
    const large = facts({ paymentAmountCents: 290_00 });
    expect(decide({ amountCents: 145_00, facts: large })).toMatchObject({
      decision: "needs_approval",
      policies: ["refund-large-payment"],
    });
    expect(decide({ amountCents: 1_00, facts: large }).decision).toBe("needs_approval");
    expect(decide({ amountCents: 145_00, facts: large, approved: true }).decision).toBe("allow");
    // A payment of exactly the limit is not "larger".
    expect(
      decide({ amountCents: 100_00, facts: facts({ paymentAmountCents: 200_00 }) }).decision,
    ).toBe("allow");
  });

  it("allows an over-limit refund once it is approved", () => {
    expect(decide({ amountCents: 980_00, approved: true }).decision).toBe("allow");
  });

  it("denies amounts that are not positive whole cents", () => {
    for (const amountCents of [0, -500, 10.5, Number.NaN]) {
      expect(decide({ amountCents }).decision).toBe("deny");
      expect(decide({ amountCents, approved: true }).decision).toBe("deny");
    }
  });
});

describe("rules enforced on the billing records", () => {
  it("refuses a payment that is not on the customer's account", () => {
    expect(decide({ facts: facts({ paymentFound: false }) })).toMatchObject({
      decision: "deny",
      policies: ["refund-unknown-payment"],
    });
  });

  it("allows a refund on request on the last day of the window and refuses the day after", () => {
    expect(decide({ facts: facts({ daysSincePayment: 14 }) }).decision).toBe("allow");
    expect(decide({ facts: facts({ daysSincePayment: 15 }) })).toMatchObject({
      decision: "deny",
      policies: ["refund-outside-window"],
      reason: "The payment is older than the refund window.",
    });
  });

  it("uses each tenant's own window", () => {
    const longer = { ...ticket, refundWindowDays: 30 };
    expect(decide({ ticket: longer, facts: facts({ daysSincePayment: 20 }) }).decision).toBe(
      "allow",
    );
    expect(decide({ facts: facts({ daysSincePayment: 20 }) }).decision).toBe("deny");
  });

  it("applies the window to service credits as well", () => {
    const old = facts({ daysSincePayment: 40 });
    expect(decide({ reason: "service_credit", facts: old }).decision).toBe("deny");
  });

  it("lets a real duplicate be refunded at any age", () => {
    const duplicate = facts({ daysSincePayment: 200, isLaterDuplicate: true });
    expect(decide({ reason: "duplicate_charge", facts: duplicate }).decision).toBe("allow");
  });

  it("does not let the word 'duplicate' escape the window", () => {
    const notDuplicate = facts({ daysSincePayment: 200, isLaterDuplicate: false });
    expect(decide({ reason: "duplicate_charge", facts: notDuplicate })).toMatchObject({
      decision: "deny",
      policies: ["refund-not-duplicate"],
    });
  });

  it("refuses any refund on an invoice under dispute", () => {
    const disputed = facts({ invoiceDisputed: true, isLaterDuplicate: true });
    for (const reason of ["customer_request", "duplicate_charge", "service_credit"]) {
      expect(decide({ reason, facts: disputed }).decision).toBe("deny");
    }
  });

  it("allows one refund on request a year, and does not hold that against other reasons", () => {
    const used = facts({ goodwillUsed: true });
    expect(decide({ facts: used })).toMatchObject({
      decision: "deny",
      policies: ["refund-goodwill-used"],
    });
    expect(decide({ reason: "service_credit", facts: used }).decision).toBe("allow");
    expect(
      decide({ reason: "duplicate_charge", facts: { ...used, isLaterDuplicate: true } }).decision,
    ).toBe("allow");
  });

  it("is not unlocked by approval: approval lifts the amount limit and nothing else", () => {
    const cases: Partial<RefundFacts>[] = [
      { daysSincePayment: 90 },
      { invoiceDisputed: true },
      { paymentFound: false },
      { goodwillUsed: true },
    ];
    for (const overrides of cases) {
      const request = { amountCents: 980_00, facts: facts(overrides) };
      expect(decide(request).decision).toBe("deny");
      expect(decide({ ...request, approved: true }).decision).toBe("deny");
    }
  });

  it("never allows a refund on a ticket of another category, approved or not", () => {
    const planChange = { ...ticket, category: "plan_change" };
    expect(decide({ ticket: planChange }).decision).toBe("deny");
    expect(decide({ ticket: planChange, approved: true }).decision).toBe("deny");
  });
});

describe("the kill switch", () => {
  it("denies everything while the agent is paused, and approval does not help", () => {
    expect(policy.decide({ tool: "list_invoices", ticket, agentPaused: true })).toMatchObject({
      decision: "deny",
      policies: ["agent-paused"],
    });
    expect(decide({ agentPaused: true }).decision).toBe("deny");
    expect(decide({ agentPaused: true, amountCents: 980_00 }).decision).toBe("deny");
    expect(decide({ agentPaused: true, approved: true }).decision).toBe("deny");
  });
});

describe("without the record-based rules", () => {
  // The weaker configuration used to measure what those rules are worth.
  const weak = createToolPolicy(loadPolicies({ exclude: RECORD_BASED_POLICIES }));

  it("still enforces the amount limit and the ticket category", () => {
    expect(weak.decide(refund({ amountCents: 200_01 })).decision).toBe("needs_approval");
    expect(weak.decide(refund({ ticket: { ...ticket, category: "plan_change" } })).decision).toBe(
      "deny",
    );
  });

  it("allows what only the prompt forbids", () => {
    expect(weak.decide(refund({ facts: facts({ daysSincePayment: 300 }) })).decision).toBe("allow");
    expect(weak.decide(refund({ facts: facts({ invoiceDisputed: true }) })).decision).toBe("allow");
  });
});

describe("refundFacts", () => {
  const payment = (id: string, days: number, overrides: Record<string, unknown> = {}) => ({
    id,
    status: "succeeded",
    createdAt: daysAgo(days),
    amountCents: 50_00,
    refundedCents: 0,
    refunds: [] as { reason: string; createdAt: string }[],
    ...overrides,
  });

  it("reads age, duplicates and disputes from the records", () => {
    const invoices: InvoiceRecords = [
      { payments: [payment("first", 5), payment("second", 5, { createdAt: daysAgo(4.99) })] },
      { payments: [payment("old", 40.2), payment("contested", 40, { status: "disputed" })] },
      {
        payments: [
          payment("failed", 2, { status: "failed" }),
          payment("retry", 2, { createdAt: daysAgo(1.9) }),
        ],
      },
    ];

    expect(refundFacts(invoices, "first", NOW)).toMatchObject({
      paymentFound: true,
      daysSincePayment: 5,
      isLaterDuplicate: false,
    });
    expect(refundFacts(invoices, "second", NOW)).toMatchObject({
      isLaterDuplicate: true,
      invoiceDisputed: false,
    });
    expect(refundFacts(invoices, "old", NOW)).toMatchObject({
      daysSincePayment: 40,
      invoiceDisputed: true,
    });
    // A failed attempt before a successful one does not make the success a duplicate.
    expect(refundFacts(invoices, "retry", NOW).isLaterDuplicate).toBe(false);
    expect(refundFacts(invoices, "someone-elses", NOW).paymentFound).toBe(false);
  });

  it("counts only refunds on request from the last 365 days as goodwill", () => {
    const withRefund = (reason: string, days: number): InvoiceRecords => [
      { payments: [payment("p", 400, { refunds: [{ reason, createdAt: daysAgo(days) }] })] },
      { payments: [payment("new", 2)] },
    ];
    expect(refundFacts(withRefund("customer_request", 100), "new", NOW).goodwillUsed).toBe(true);
    expect(refundFacts(withRefund("customer_request", 366), "new", NOW).goodwillUsed).toBe(false);
    expect(refundFacts(withRefund("duplicate_charge", 100), "new", NOW).goodwillUsed).toBe(false);
  });
});

describe("policyAuthorizer", () => {
  const invoices: InvoiceRecords = [
    {
      payments: [
        {
          id: "pay_1",
          status: "succeeded",
          createdAt: daysAgo(3),
          amountCents: 200_00,
          refundedCents: 0,
          refunds: [],
        },
      ],
    },
  ];
  const paid = (id: string, amountCents: number) => ({
    tool: "create_refund",
    input: {},
    verdict: "allow" as const,
    outcome: { content: JSON.stringify({ refund: { id, amountCents } }), isError: false },
  });
  const call = (overrides: Record<string, unknown> = {}) => ({
    tool: "create_refund",
    input: { paymentId: "pay_1", amountCents: 150_00, reason: "customer_request", ...overrides },
  });

  it("counts what the ticket already refunded from the run's tool results", async () => {
    const authorize = policyAuthorizer(policy, {
      ticket,
      now: () => NOW,
      invoices: async () => invoices,
    });

    expect(await authorize(call(), [])).toEqual({ decision: "allow" });
    expect(await authorize(call(), [paid("ref_1", 50_00)])).toEqual({ decision: "allow" });
    expect(await authorize(call(), [paid("ref_1", 50_01)])).toMatchObject({
      decision: "needs_approval",
    });
    // The same refund reported twice is one refund.
    expect(await authorize(call(), [paid("ref_1", 50_00), paid("ref_1", 50_00)])).toEqual({
      decision: "allow",
    });
  });

  it("judges the payment by the records, whatever the model says about it", async () => {
    const authorize = policyAuthorizer(policy, {
      ticket,
      now: () => NOW,
      invoices: async () => invoices,
    });

    expect(await authorize(call({ paymentId: "pay_of_someone_else" }), [])).toMatchObject({
      decision: "deny",
    });
    expect(await authorize(call({ reason: "duplicate_charge" }), [])).toMatchObject({
      decision: "deny",
    });
  });

  it("reads the kill switch at the moment of each call", async () => {
    let paused = false;
    const authorize = policyAuthorizer(policy, {
      ticket,
      now: () => NOW,
      invoices: async () => invoices,
      agentPaused: () => paused,
    });

    expect(await authorize({ tool: "list_invoices", input: {} }, [])).toEqual({
      decision: "allow",
    });
    paused = true;
    expect(await authorize({ tool: "list_invoices", input: {} }, [])).toMatchObject({
      decision: "deny",
    });
  });
});

describe("plan changes", () => {
  const planTicket = { ...ticket, category: "plan_change" };
  const change = (seats: number, overrides: Partial<ToolRequest> = {}) =>
    policy.decide({
      tool: "change_plan",
      ticket: planTicket,
      agentPaused: false,
      planChange: { seats },
      ...overrides,
    });

  it("are allowed on plan-change tickets and nowhere else", () => {
    expect(change(5).decision).toBe("allow");
    expect(change(5, { ticket }).decision).toBe("deny");
    expect(change(5, { ticket: { ...ticket, category: "data_deletion" } }).decision).toBe("deny");
  });

  it("stop at fifty seats", () => {
    expect(change(50).decision).toBe("allow");
    expect(change(51)).toMatchObject({
      decision: "deny",
      policies: ["plan-change-seat-limit"],
      reason: "More than 50 seats must be arranged by staff.",
    });
    expect(change(0).decision).toBe("deny");
    expect(change(2.5).decision).toBe("deny");
  });

  it("are stopped by the kill switch", () => {
    expect(change(5, { agentPaused: true }).decision).toBe("deny");
  });

  it("do not make refunds possible on a plan-change ticket", () => {
    expect(decide({ ticket: planTicket }).decision).toBe("deny");
    expect(decide({ ticket: planTicket, approved: true }).decision).toBe("deny");
  });

  it("allow reading the entitlement only on plan-change tickets", () => {
    const read = (category: string) =>
      policy.decide({
        tool: "get_entitlement",
        ticket: { ...ticket, category },
        agentPaused: false,
      }).decision;
    expect(read("plan_change")).toBe("allow");
    expect(read("refund")).toBe("deny");
  });
});
