import { z } from "zod";
import { CHANGE_PLAN_TOOL } from "./plan-change.ts";
import { REASONS, RESOLVE_TOOL, type Resolution } from "./resolution.ts";
import type { ToolCallRecord } from "./tools.ts";

const REFUND_TOOL = "create_refund";

const refundAnswer = z.object({
  refund: z.object({ id: z.string(), amountCents: z.number().int().positive() }),
});

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
    let result: unknown;
    try {
      result = JSON.parse(call.outcome.content);
    } catch {
      // A result that is not JSON is not evidence of a refund.
      continue;
    }
    const parsed = refundAnswer.safeParse(result);
    if (parsed.success) refunds.set(parsed.data.refund.id, parsed.data.refund);
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

const MONEY = /(?:[$€£]|\b(?:USD|EUR|GBP)\s)\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?(?!\d)/g;

function centsIn(text: string): Set<number> {
  const found = new Set<number>();
  for (const match of text.matchAll(MONEY)) {
    found.add(Number((match[1] ?? "").replaceAll(",", "")) * 100 + Number(match[2] ?? 0));
  }
  return found;
}

/**
 * Every amount in a JSON value: integers stored under a key ending in
 * "Cents", and money written out inside any string, such as a help-centre
 * passage.
 */
function centsFields(value: unknown, found: Set<number>): void {
  if (typeof value === "string") {
    for (const cents of centsIn(value)) found.add(cents);
  } else if (Array.isArray(value)) {
    for (const item of value) centsFields(item, found);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, inner] of Object.entries(value)) {
      if (key.endsWith("Cents") && Number.isInteger(inner)) found.add(inner as number);
      else centsFields(inner, found);
    }
  }
}

/**
 * Money amounts stated in a reply that appear nowhere in what the agent was
 * given: not in the instructions, not in the ticket, not in any tool result,
 * and not as the total refunded. Such an amount was computed or invented by
 * the model.
 *
 * This is a measurement, not a gate. An agent may rightly state a sum it
 * worked out, such as seats times price, so the check runs in the evals to
 * find out how often it fires before anything is decided on it.
 */
export function ungroundedAmounts(
  reply: string,
  given: { texts: string[]; toolCalls: ToolCallRecord[] },
): string[] {
  const known = new Set<number>();
  for (const text of given.texts) for (const cents of centsIn(text)) known.add(cents);
  for (const call of given.toolCalls) {
    try {
      centsFields(JSON.parse(call.outcome.content), known);
    } catch {
      for (const cents of centsIn(call.outcome.content)) known.add(cents);
    }
  }
  known.add(refundsMade(given.toolCalls).reduce((sum, refund) => sum + refund.amountCents, 0));
  return [...centsIn(reply)]
    .filter((cents) => !known.has(cents))
    .map((cents) => (cents / 100).toFixed(2));
}
