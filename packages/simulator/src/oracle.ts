import { CATALOG } from "./catalog.ts";
import { decideRefund, type ReasonCode, type RefundIntent } from "./refund-policy.ts";
import type { PlanChangeIntent, Solver, SolverResult } from "./scenario.ts";
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
export function createOracle(
  intent: RefundIntent | PlanChangeIntent,
  lookups: { query: string; phrase: string }[] = [],
): Solver {
  const decide = "kind" in intent ? decidePlanChange(intent) : decideTicket(intent);
  return async (context): Promise<SolverResult> => {
    const result = await decide(context);
    // Answer the customer's side questions from the help centre, quoting the
    // passage that search returns. If search cannot find it, the reply lacks
    // the fact and the scenario fails, which is the point.
    for (const lookup of lookups) {
      const hits = (await context.helpCenter?.(lookup.query)) ?? [];
      const passage = hits.find((hit) => `${hit.heading} ${hit.body}`.includes(lookup.phrase));
      if (passage) result.reply += ` ${passage.body}`;
    }
    return result;
  };
}

function decideTicket(intent: RefundIntent): Solver {
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

const MAX_SEATS = 50;

/** Solves a plan-change ticket by the written policy, using the same two service clients the agent's tools use. */
function decidePlanChange(intent: PlanChangeIntent): Solver {
  return async (context): Promise<SolverResult> => {
    const { customer, ticket, billing, entitlements } = context;
    const subscriptions = await billing.listSubscriptions(customer.id);
    const subscription = subscriptions.find((candidate) => candidate.status === "active");

    if (!subscription) {
      return {
        outcome: "refused",
        reasonCode: "subscription_not_active",
        reply:
          "Your subscription is cancelled, so it cannot be changed. You can subscribe again at any time.",
      };
    }
    if (intent.planCode === undefined && intent.seats === undefined) {
      return {
        outcome: "needs_clarification",
        reasonCode: "request_unclear",
        reply: "Which plan would you like, and how many seats?",
      };
    }
    const planCode = intent.planCode ?? subscription.plan.code;
    const seats = intent.seats ?? subscription.seats;
    const plans =
      Object.values(CATALOG).find((entry) => entry.tenant.id === context.tenant.id)?.plans ?? [];
    const target = plans.find((plan) => plan.code === planCode);

    if (!target) {
      return {
        outcome: "refused",
        reasonCode: "plan_not_available",
        reply: `We have no plan called ${planCode}.`,
      };
    }
    if (target.billingInterval !== subscription.plan.billingInterval) {
      return {
        outcome: "handed_to_staff",
        reasonCode: "billing_interval_change",
        reply:
          "Moving between monthly and annual billing is arranged by our team, who will reply to you directly.",
      };
    }
    if (seats > MAX_SEATS) {
      return {
        outcome: "handed_to_staff",
        reasonCode: "seat_limit",
        reply: `More than ${MAX_SEATS} seats is arranged by our team, who will reply to you directly.`,
      };
    }
    if (planCode === subscription.plan.code && seats === subscription.seats) {
      return {
        outcome: "refused",
        reasonCode: "no_change_needed",
        reply: `Your subscription is already on ${target.name} with ${seats} seats.`,
      };
    }

    const key = `${ticket.id}:plan-change`;
    await billing.changeSubscription(subscription.id, { planCode, seats }, key);
    await entitlements.setEntitlement(customer.id, { planCode, seats }, key);
    return {
      outcome: "plan_changed",
      reasonCode: "plan_changed",
      reply: `Your subscription is now on ${target.name} with ${seats} seats, from your next renewal. Nothing is charged today.`,
    };
  };
}
