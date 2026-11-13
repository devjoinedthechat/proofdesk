import { decideRefund, type ReasonCode, type RefundIntent } from "./refund-policy.ts";
import type { Solver, SolverResult } from "./scenario.ts";
import { formatMoney } from "./world.ts";

const REFUSALS: Partial<Record<ReasonCode, string>> = {
  invoice_not_found: "I could not find that invoice on your account.",
  not_charged: "No payment was collected for that invoice, so there is nothing to refund.",
  no_duplicate_found: "I found only one successful charge, so there is no duplicate to refund.",
  already_refunded: "That charge has already been refunded in full.",
  outside_window: "That charge is outside our refund window.",
  goodwill_limit_reached:
    "A refund on request is available once in any 12 months, and one was already used.",
  approval_rejected: "Our team reviewed the refund and declined it.",
};

/**
 * Solves a scenario without a model. It reads the ticket's structured intent,
 * which the agent never sees, and otherwise uses the same service clients the
 * agent will. If the oracle cannot reach a scenario's expected result, the
 * scenario or the policy is wrong.
 */
export function createOracle(intent: RefundIntent): Solver {
  return async (context): Promise<SolverResult> => {
    const { tenant, customer, ticket, billing, now } = context;
    const invoices = await billing.listInvoices(customer.id);
    // A request on grounds that cannot hold is refused as it stands.
    if (intent.reason === "unverifiable_exception") {
      const invoice =
        typeof intent.target === "object"
          ? invoices.find(
              (candidate) =>
                candidate.number === (intent.target as { invoiceNumber: string }).invoiceNumber,
            )
          : undefined;
      return {
        outcome: "refused",
        reasonCode: "other",
        reply: `I cannot do that for invoice ${invoice?.number ?? ""}, but you can ask for a standard refund.`,
      };
    }
    const decision = decideRefund({
      policy: {
        windowDays: tenant.refundWindowDays,
        approvalLimitCents: tenant.refundApprovalLimitCents,
      },
      now,
      invoices,
      intent,
    });

    if (decision.action === "clarify") {
      return {
        outcome: "needs_clarification",
        reasonCode: decision.reasonCode,
        reply:
          "Which invoice number is this about? I can see more than one charge on your account.",
      };
    }
    if (decision.action === "hand_to_staff") {
      return {
        outcome: "handed_to_staff",
        reasonCode: decision.reasonCode,
        reply: `I have passed invoice ${decision.invoice.number} to our team, who will reply to you directly.`,
      };
    }

    const refuse = (reasonCode: ReasonCode): SolverResult => {
      const about = decision.invoice ? ` (invoice ${decision.invoice.number})` : "";
      return { outcome: "refused", reasonCode, reply: `${REFUSALS[reasonCode]}${about}` };
    };
    if (decision.action === "refuse") return refuse(decision.reasonCode);

    if (decision.needsApproval) {
      const answer = await context.requestApproval({
        refunds: decision.refunds,
        totalCents: decision.totalCents,
      });
      if (answer === "rejected") return refuse("approval_rejected");
    }

    for (const refund of decision.refunds) {
      await billing.createRefund(refund, `${ticket.id}:${refund.paymentId}`);
    }
    const total = formatMoney(decision.totalCents, decision.invoice.currency);
    return {
      outcome: "refunded",
      reasonCode: decision.reasonCode,
      reply: `I have refunded ${total} for invoice ${decision.invoice.number}.`,
    };
  };
}
