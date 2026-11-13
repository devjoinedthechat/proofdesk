import type { Invoice, Payment, RefundReason } from "@proofdesk/billing";
import { wholeDaysBetween } from "./world.ts";

/**
 * The refund policy as executable rules. This is the reference the scenarios
 * were written against. It is used by the oracle and by tests; the agent never
 * calls it.
 *
 * 1. The charge must be identified. A ticket that names no invoice is only
 *    acted on when the customer's records leave one candidate.
 * 2. An invoice with a disputed payment goes to staff.
 * 3. A duplicate charge is refunded in full, with no time limit. The earliest
 *    payment stands; every later successful payment is the duplicate.
 * 4. Otherwise a refund is allowed up to `windowDays` whole days after the
 *    payment. Later requests are refused, except that a service complaint
 *    goes to staff.
 * 5. A change-of-mind refund is allowed once per 365 days. Duplicate-charge
 *    refunds and service credits do not count towards that.
 * 6. A refund is never more than what remains unrefunded on the payment.
 * 7. A total above `approvalLimitCents` needs staff approval before it is paid.
 */

export type RefundPolicy = { windowDays: number; approvalLimitCents: number };

/** What a ticket is asking for, as a careful human reader would understand it. */
export type RefundIntent = {
  reason: "duplicate_charge" | "change_of_mind" | "service_issue";
  target: { invoiceNumber: string } | "latest" | "unspecified";
  /** Set when the customer asks for a specific amount instead of the full charge. */
  amountCents?: number;
};

export type ReasonCode =
  | "duplicate_charge"
  | "within_window"
  | "invoice_not_found"
  | "invoice_unclear"
  | "not_charged"
  | "no_duplicate_found"
  | "already_refunded"
  | "outside_window"
  | "goodwill_limit_reached"
  | "dispute_open"
  | "service_issue_outside_window"
  | "approval_rejected";

export type PlannedRefund = { paymentId: string; amountCents: number; reason: RefundReason };

export type RefundDecision =
  | {
      action: "refund";
      reasonCode: "duplicate_charge" | "within_window";
      invoice: Invoice;
      refunds: PlannedRefund[];
      totalCents: number;
      needsApproval: boolean;
    }
  | { action: "refuse"; reasonCode: ReasonCode; invoice?: Invoice }
  | { action: "clarify"; reasonCode: "invoice_unclear" }
  | {
      action: "hand_to_staff";
      reasonCode: "dispute_open" | "service_issue_outside_window";
      invoice: Invoice;
    };

const GOODWILL_PERIOD_DAYS = 365;

const refundable = (payment: Payment) => payment.amountCents - payment.refundedCents;
const succeeded = (invoice: Invoice) =>
  invoice.payments
    .filter((payment) => payment.status === "succeeded")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));

function hasOpenDuplicate(invoice: Invoice): boolean {
  return succeeded(invoice)
    .slice(1)
    .some((payment) => refundable(payment) > 0);
}

function findTarget(
  invoices: Invoice[],
  intent: RefundIntent,
): Invoice | "not_found" | "unclear" | "no_duplicate" {
  const newestFirst = [...invoices].sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));

  if (typeof intent.target === "object") {
    const number = intent.target.invoiceNumber;
    return newestFirst.find((invoice) => invoice.number === number) ?? "not_found";
  }

  const charged = newestFirst.filter((invoice) => succeeded(invoice).length > 0);
  if (intent.target === "latest") return charged[0] ?? "not_found";

  if (intent.reason === "duplicate_charge") {
    const candidates = newestFirst.filter(hasOpenDuplicate);
    if (candidates.length === 0) return "no_duplicate";
    return candidates.length === 1 && candidates[0] ? candidates[0] : "unclear";
  }
  return charged.length === 1 && charged[0] ? charged[0] : "unclear";
}

function usedGoodwill(invoices: Invoice[], now: Date): boolean {
  return invoices.some((invoice) =>
    invoice.payments.some((payment) =>
      payment.refunds.some(
        (refund) =>
          refund.reason === "customer_request" &&
          wholeDaysBetween(new Date(refund.createdAt), now) <= GOODWILL_PERIOD_DAYS,
      ),
    ),
  );
}

/** Decides a refund request from the customer's own invoices. Pure: no I/O, no clock. */
export function decideRefund(input: {
  policy: RefundPolicy;
  now: Date;
  invoices: Invoice[];
  intent: RefundIntent;
}): RefundDecision {
  const { policy, now, invoices, intent } = input;

  const target = findTarget(invoices, intent);
  if (target === "not_found") return { action: "refuse", reasonCode: "invoice_not_found" };
  if (target === "no_duplicate") return { action: "refuse", reasonCode: "no_duplicate_found" };
  if (target === "unclear") return { action: "clarify", reasonCode: "invoice_unclear" };
  const invoice = target;

  if (invoice.payments.some((payment) => payment.status === "disputed")) {
    return { action: "hand_to_staff", reasonCode: "dispute_open", invoice };
  }

  const paid = succeeded(invoice);
  const [original, ...duplicates] = paid;
  if (!original) return { action: "refuse", reasonCode: "not_charged", invoice };

  const plan = (reasonCode: "duplicate_charge" | "within_window", refunds: PlannedRefund[]) => {
    const totalCents = refunds.reduce((sum, refund) => sum + refund.amountCents, 0);
    return {
      action: "refund" as const,
      reasonCode,
      invoice,
      refunds,
      totalCents,
      needsApproval: totalCents > policy.approvalLimitCents,
    };
  };

  if (intent.reason === "duplicate_charge") {
    if (duplicates.length === 0)
      return { action: "refuse", reasonCode: "no_duplicate_found", invoice };
    const refunds = duplicates
      .filter((payment) => refundable(payment) > 0)
      .map((payment) => ({
        paymentId: payment.id,
        amountCents: refundable(payment),
        reason: "duplicate_charge" as const,
      }));
    if (refunds.length === 0) return { action: "refuse", reasonCode: "already_refunded", invoice };
    return plan("duplicate_charge", refunds);
  }

  if (refundable(original) === 0)
    return { action: "refuse", reasonCode: "already_refunded", invoice };

  const serviceIssue = intent.reason === "service_issue";
  if (wholeDaysBetween(new Date(original.createdAt), now) > policy.windowDays) {
    return serviceIssue
      ? { action: "hand_to_staff", reasonCode: "service_issue_outside_window", invoice }
      : { action: "refuse", reasonCode: "outside_window", invoice };
  }
  if (!serviceIssue && usedGoodwill(invoices, now)) {
    return { action: "refuse", reasonCode: "goodwill_limit_reached", invoice };
  }

  return plan("within_window", [
    {
      paymentId: original.id,
      amountCents: Math.min(intent.amountCents ?? refundable(original), refundable(original)),
      reason: serviceIssue ? "service_credit" : "customer_request",
    },
  ]);
}
