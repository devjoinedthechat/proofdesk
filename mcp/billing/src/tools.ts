import type { BillingClient } from "@proofdesk/billing";
import { SCOPES } from "@proofdesk/identity";
import { z } from "zod";

/**
 * One billing tool: what the model is told, what scope a caller needs, and
 * what it does. The MCP server registers these, and evaluations can run the
 * same definitions against a billing client directly.
 */
export type BillingTool = {
  name: string;
  scope: string;
  description: string;
  input: z.ZodObject;
  /** True when a successful call changes billing records. */
  writes: boolean;
  run(billing: BillingClient, customerId: string, args: unknown): Promise<unknown>;
};

function define<Input extends z.ZodObject>(tool: {
  name: string;
  scope: string;
  description: string;
  input: Input;
  writes: boolean;
  run(billing: BillingClient, customerId: string, args: z.infer<Input>): Promise<unknown>;
}): BillingTool {
  return {
    ...tool,
    run: (billing, customerId, args) => tool.run(billing, customerId, tool.input.parse(args)),
  };
}

// No tool takes a customer id. The customer is fixed by the caller's
// credential, so a manipulated model cannot point a tool at someone else.
export const BILLING_TOOLS: BillingTool[] = [
  define({
    name: "list_invoices",
    scope: SCOPES.billingRead,
    description:
      "Lists the customer's invoices, newest first. Each invoice includes its payments, their status, and any refunds already made against them.",
    input: z.object({
      invoiceNumber: z
        .string()
        .optional()
        .describe("Return only the invoice with this number, such as INV-000123."),
    }),
    writes: false,
    run: async (billing, customerId, { invoiceNumber }) => ({
      invoices: await billing.listInvoices(
        customerId,
        invoiceNumber === undefined ? {} : { number: invoiceNumber },
      ),
    }),
  }),
  define({
    name: "list_subscriptions",
    scope: SCOPES.billingRead,
    description: "Lists the customer's subscriptions with plan, price, seats and status.",
    input: z.object({}),
    writes: false,
    run: async (billing, customerId) => ({
      subscriptions: await billing.listSubscriptions(customerId),
    }),
  }),
  define({
    name: "create_refund",
    scope: SCOPES.billingRefund,
    description:
      "Refunds money to the customer against one of their payments. This moves real money and cannot be undone. Repeating a call with the same idempotencyKey returns the first refund instead of paying again.",
    input: z.object({
      paymentId: z.string().describe("The payment to refund, from list_invoices."),
      amountCents: z.number().int().positive().describe("Amount to refund, in cents."),
      reason: z.enum(["duplicate_charge", "customer_request", "service_credit"]),
      idempotencyKey: z
        .string()
        .min(8)
        .max(200)
        .describe("A stable key for this refund. Reuse it when retrying."),
    }),
    writes: true,
    run: async (billing, _customerId, { idempotencyKey, ...request }) => ({
      refund: await billing.createRefund(request, idempotencyKey),
    }),
  }),
];
