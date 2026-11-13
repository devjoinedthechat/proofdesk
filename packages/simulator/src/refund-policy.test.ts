import type { Invoice, Payment } from "@proofdesk/billing";
import { describe, expect, it } from "vitest";
import { decideRefund, type RefundIntent } from "./refund-policy.ts";
import { daysBefore, SIM_NOW } from "./world.ts";

const policy = { windowDays: 14, approvalLimitCents: 200_00 };

function payment(id: string, daysAgo: number, overrides: Partial<Payment> = {}): Payment {
  return {
    id,
    amountCents: 50_00,
    status: "succeeded",
    createdAt: daysBefore(SIM_NOW, daysAgo).toISOString(),
    refundedCents: 0,
    refunds: [],
    ...overrides,
  };
}

function invoice(number: string, daysAgo: number, payments: Payment[]): Invoice {
  const at = daysBefore(SIM_NOW, daysAgo).toISOString();
  return {
    id: `inv_${number}`,
    number,
    customerId: "cus_1",
    subscriptionId: "sub_1",
    status: "paid",
    amountCents: payments[0]?.amountCents ?? 50_00,
    currency: "USD",
    periodStart: at,
    periodEnd: at,
    issuedAt: at,
    payments,
  };
}

const decide = (invoices: Invoice[], intent: RefundIntent) =>
  decideRefund({ policy, now: SIM_NOW, invoices, intent });

const named = (
  number: string,
  reason: RefundIntent["reason"] = "change_of_mind",
): RefundIntent => ({
  reason,
  target: { invoiceNumber: number },
});

describe("decideRefund", () => {
  it("allows a refund on the last day of the window and refuses the day after", () => {
    const onTime = decide([invoice("A", 14, [payment("p", 14)])], named("A"));
    const late = decide([invoice("A", 15, [payment("p", 15)])], named("A"));

    expect(onTime).toMatchObject({ action: "refund", reasonCode: "within_window" });
    expect(late).toMatchObject({ action: "refuse", reasonCode: "outside_window" });
  });

  it("needs approval above the limit but not at it", () => {
    const at = decide([invoice("A", 1, [payment("p", 1, { amountCents: 200_00 })])], named("A"));
    const above = decide([invoice("A", 1, [payment("p", 1, { amountCents: 200_01 })])], named("A"));

    expect(at).toMatchObject({ action: "refund", needsApproval: false });
    expect(above).toMatchObject({ action: "refund", needsApproval: true });
  });

  it("keeps the earliest payment and refunds every later duplicate, whatever its age", () => {
    const result = decide(
      [invoice("A", 90, [payment("p2", 89), payment("p1", 90), payment("p3", 88)])],
      named("A", "duplicate_charge"),
    );

    expect(result).toMatchObject({
      action: "refund",
      reasonCode: "duplicate_charge",
      totalCents: 100_00,
      refunds: [
        { paymentId: "p2", amountCents: 50_00, reason: "duplicate_charge" },
        { paymentId: "p3", amountCents: 50_00, reason: "duplicate_charge" },
      ],
    });
  });

  it("does not treat a failed attempt as a duplicate", () => {
    const result = decide(
      [invoice("A", 2, [payment("p1", 2, { status: "failed" }), payment("p2", 2)])],
      named("A", "duplicate_charge"),
    );
    expect(result).toMatchObject({ action: "refuse", reasonCode: "no_duplicate_found" });
  });

  it("never refunds more than what remains on the payment", () => {
    const partlyRefunded = payment("p", 3, { refundedCents: 20_00 });
    const result = decide([invoice("A", 3, [partlyRefunded])], {
      ...named("A"),
      amountCents: 999_00,
    });
    expect(result).toMatchObject({ action: "refund", totalCents: 30_00 });
  });

  it("allows one refund on request per year, and does not count other refund reasons", () => {
    const refundOf = (reason: "customer_request" | "service_credit", daysAgo: number) =>
      payment("old", 60, {
        refundedCents: 50_00,
        refunds: [
          {
            id: "ref_1",
            paymentId: "old",
            amountCents: 50_00,
            reason,
            createdAt: daysBefore(SIM_NOW, daysAgo).toISOString(),
          },
        ],
      });
    const current = invoice("B", 2, [payment("new", 2)]);

    const used = decide(
      [invoice("A", 60, [refundOf("customer_request", 50)]), current],
      named("B"),
    );
    const credit = decide(
      [invoice("A", 60, [refundOf("service_credit", 50)]), current],
      named("B"),
    );
    const longAgo = decide(
      [invoice("A", 60, [refundOf("customer_request", 366)]), current],
      named("B"),
    );

    expect(used).toMatchObject({ action: "refuse", reasonCode: "goodwill_limit_reached" });
    expect(credit).toMatchObject({ action: "refund" });
    expect(longAgo).toMatchObject({ action: "refund" });
  });

  it("sends a disputed payment to staff before any other rule applies", () => {
    const result = decide([invoice("A", 2, [payment("p", 2, { status: "disputed" })])], named("A"));
    expect(result).toMatchObject({ action: "hand_to_staff", reasonCode: "dispute_open" });
  });

  it("asks which charge is meant only when the records leave more than one candidate", () => {
    const one = [invoice("A", 2, [payment("p", 2)])];
    const two = [...one, invoice("B", 5, [payment("q", 5)])];
    const intent: RefundIntent = { reason: "change_of_mind", target: "unspecified" };

    expect(decide(one, intent)).toMatchObject({ action: "refund" });
    expect(decide(two, intent)).toMatchObject({ action: "clarify" });
  });
});
