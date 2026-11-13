import {
  type BillingClient,
  invoiceList,
  planChangeResult,
  refundResult,
  subscriptionList,
} from "@proofdesk/billing";
import { SCOPES } from "@proofdesk/identity";
import { defineTool, type ServiceTool } from "@proofdesk/mcp-server";
import { z } from "zod";

export type BillingTool = ServiceTool<BillingClient>;

const define = <Input extends z.ZodObject, Output extends z.ZodObject>(
  tool: Parameters<typeof defineTool<BillingClient, Input, Output>>[0],
) => defineTool<BillingClient, Input, Output>(tool);

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
    output: invoiceList,
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
    output: subscriptionList,
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
    output: refundResult,
    writes: true,
    run: async (billing, _customerId, { idempotencyKey, ...request }) => ({
      refund: await billing.createRefund(request, idempotencyKey),
    }),
  }),
  define({
    name: "change_subscription",
    scope: SCOPES.billingPlan,
    description:
      "Changes the plan or the number of seats of one of the customer's subscriptions, from the next renewal. Repeating a call with the same idempotencyKey returns the first change instead of making another.",
    input: z.object({
      subscriptionId: z.string().describe("The subscription to change, from list_subscriptions."),
      planCode: z.string().describe("The plan to move to, such as team-monthly."),
      seats: z.number().int().min(1).max(500),
      idempotencyKey: z.string().min(8).max(200),
    }),
    output: planChangeResult,
    writes: true,
    run: async (billing, _customerId, { subscriptionId, idempotencyKey, ...request }) => ({
      change: await billing.changeSubscription(subscriptionId, request, idempotencyKey),
    }),
  }),
  define({
    name: "revert_subscription_change",
    scope: SCOPES.billingPlan,
    description:
      "Undoes a subscription change, putting the plan and seats back exactly as they were. Safe to repeat.",
    input: z.object({ changeId: z.string() }),
    output: planChangeResult,
    writes: true,
    run: async (billing, _customerId, { changeId }) => ({
      change: await billing.revertPlanChange(changeId),
    }),
  }),
];
