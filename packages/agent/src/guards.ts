import { CHANGE_PLAN_TOOL } from "./plan-change.ts";
import { REASONS, RESOLVE_TOOL, type Resolution } from "./resolution.ts";
import type { ToolCallRecord } from "./tools.ts";

const REFUND_TOOL = "create_refund";

/**
 * Words a customer should never see: the names of the agent's tools, its
 * internal reason codes, and phrases from its instructions. Their presence in
 * a reply means the agent is describing its own machinery.
 */
const INTERNAL_TERMS = [
  RESOLVE_TOOL,
  CHANGE_PLAN_TOOL,
  "list_subscriptions",
  "list_invoices",
  REFUND_TOOL,
  "system prompt",
  "untrusted content",
  ...Object.keys(REASONS).filter((code) => code.includes("_")),
].map((term) => term.toLowerCase());

/**
 * Refunds that were actually made during a run, read from the tool results and
 * not from the model's account of them. A repeated call that billing answered
 * with the same refund counts once.
 */
export function refundsMade(toolCalls: ToolCallRecord[]): { id: string; amountCents: number }[] {
  const refunds = new Map<string, { id: string; amountCents: number }>();
  for (const call of toolCalls) {
    if (call.tool !== REFUND_TOOL || call.outcome.isError) continue;
    try {
      const refund = JSON.parse(call.outcome.content)?.refund;
      if (typeof refund?.id === "string" && typeof refund.amountCents === "number") {
        refunds.set(refund.id, { id: refund.id, amountCents: refund.amountCents });
      }
    } catch {
      // A result that is not JSON is not evidence of a refund.
    }
  }
  return [...refunds.values()];
}

/** Every way a currency amount is commonly written, for matching against a reply. */
function amountForms(cents: number): string[] {
  const plain = (cents / 100).toFixed(2);
  const grouped = plain.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return [...new Set([plain, grouped])];
}

/**
 * Checks what the agent says against what it did, before the reply is sent.
 * The model's own account of its actions is not trusted: a reply that claims
 * a refund that was never made, or hides one that was, is stopped here.
 */
export function checkResolution(resolution: Resolution, toolCalls: ToolCallRecord[]): string[] {
  const violations: string[] = [];
  const refunds = refundsMade(toolCalls);
  const total = refunds.reduce((sum, refund) => sum + refund.amountCents, 0);

  if (resolution.outcome === "refunded" && refunds.length === 0) {
    violations.push("claims_refund_not_made");
  }
  if (resolution.outcome !== "refunded" && refunds.length > 0) {
    violations.push("refund_made_not_reported");
  }
  if (refunds.length > 0 && !amountForms(total).some((form) => resolution.reply.includes(form))) {
    violations.push("reply_omits_refunded_amount");
  }
  const planChanged = toolCalls.some(
    (call) => call.tool === CHANGE_PLAN_TOOL && !call.outcome.isError,
  );
  if (resolution.outcome === "plan_changed" && !planChanged) {
    violations.push("claims_plan_change_not_made");
  }
  if (resolution.outcome !== "plan_changed" && planChanged) {
    violations.push("plan_change_not_reported");
  }
  const reply = resolution.reply.toLowerCase();
  if (INTERNAL_TERMS.some((term) => reply.includes(term))) {
    violations.push("reply_leaks_internals");
  }
  return violations;
}
