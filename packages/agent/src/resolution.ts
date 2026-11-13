import type { ToolDefinition } from "@proofdesk/gateway";
import { z } from "zod";

export const OUTCOMES = ["refunded", "refused", "needs_clarification", "handed_to_staff"] as const;

/** Why a ticket ended the way it did. One vocabulary for the agent, the audit log and the evals. */
export const REASONS = {
  duplicate_charge: "A duplicate charge was refunded.",
  within_window: "A refund inside the refund window was made.",
  invoice_not_found: "The invoice named in the ticket is not on this customer's account.",
  invoice_unclear: "The ticket does not say which charge it is about and the account has several.",
  not_charged: "No payment was collected for the invoice, so there is nothing to refund.",
  no_duplicate_found: "The customer reported a duplicate charge but only one payment succeeded.",
  already_refunded: "The charge was already refunded in full.",
  outside_window: "The charge is older than the refund window allows.",
  goodwill_limit_reached:
    "The customer already used their one refund on request in the last 12 months.",
  dispute_open: "A payment on the invoice is under a bank dispute.",
  service_issue_outside_window: "A service complaint about a charge older than the refund window.",
  approval_rejected: "Staff reviewed the refund and declined it.",
  other: "None of the above fits.",
} as const;

export type Outcome = (typeof OUTCOMES)[number];
export type Reason = keyof typeof REASONS;

const reasonCodes = Object.keys(REASONS) as [Reason, ...Reason[]];

export const resolutionSchema = z.strictObject({
  outcome: z.enum(OUTCOMES),
  reasonCode: z.enum(reasonCodes),
  reply: z.string().trim().min(1).max(4000),
});

export type Resolution = z.infer<typeof resolutionSchema>;

export const RESOLVE_TOOL = "resolve_ticket";

/**
 * The tool that ends a ticket. Current models do not accept a forced tool
 * choice, so the prompt asks for this call and the loop checks that it came.
 */
export const resolveTool: ToolDefinition = {
  name: RESOLVE_TOOL,
  description: [
    "Ends your work on the ticket and sends your reply to the customer. Call it exactly once, alone, after you have seen the result of every other tool call.",
    "Outcomes: refunded (you issued a refund), refused (policy does not allow what was asked), needs_clarification (you need the customer to answer a question first), handed_to_staff (a person must decide).",
    "Reason codes:",
    ...Object.entries(REASONS).map(([code, meaning]) => `- ${code}: ${meaning}`),
  ].join("\n"),
  strict: true,
  inputSchema: {
    type: "object",
    properties: {
      outcome: { type: "string", enum: [...OUTCOMES] },
      reasonCode: { type: "string", enum: reasonCodes },
      reply: { type: "string", description: "The message the customer will read." },
    },
    required: ["outcome", "reasonCode", "reply"],
    additionalProperties: false,
  },
};
