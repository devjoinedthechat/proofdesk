import { z } from "zod";

/** The wire format of the billing service, shared by the server and its client. */

const timestamp = z.iso.datetime();

export const refundReason = z.enum(["duplicate_charge", "customer_request", "service_credit"]);

export const refund = z.object({
  id: z.string(),
  paymentId: z.string(),
  amountCents: z.number().int().positive(),
  reason: refundReason,
  createdAt: timestamp,
});

export const payment = z.object({
  id: z.string(),
  amountCents: z.number().int().positive(),
  status: z.enum(["succeeded", "failed", "disputed"]),
  createdAt: timestamp,
  /** Total already refunded against this payment. */
  refundedCents: z.number().int().nonnegative(),
  refunds: z.array(refund),
});

export const invoice = z.object({
  id: z.string(),
  number: z.string(),
  customerId: z.string(),
  subscriptionId: z.string(),
  status: z.enum(["open", "paid", "void"]),
  amountCents: z.number().int().nonnegative(),
  currency: z.string().length(3),
  periodStart: timestamp,
  periodEnd: timestamp,
  issuedAt: timestamp,
  /** The customer's own reference for this purchase, as they typed it. */
  reference: z.string().nullable(),
  payments: z.array(payment),
});

export const subscription = z.object({
  id: z.string(),
  customerId: z.string(),
  status: z.enum(["active", "past_due", "canceled"]),
  seats: z.number().int().positive(),
  startedAt: timestamp,
  currentPeriodStart: timestamp,
  currentPeriodEnd: timestamp,
  canceledAt: timestamp.nullable(),
  plan: z.object({
    code: z.string(),
    name: z.string(),
    billingInterval: z.enum(["month", "year"]),
    priceCents: z.number().int().nonnegative(),
    currency: z.string().length(3),
  }),
});

export const createRefundRequest = z.strictObject({
  paymentId: z.string().min(1),
  amountCents: z.number().int().positive(),
  reason: refundReason,
});

export const invoiceList = z.object({ invoices: z.array(invoice) });
export const subscriptionList = z.object({ subscriptions: z.array(subscription) });
export const refundResult = z.object({ refund });

export type Refund = z.infer<typeof refund>;
export type Payment = z.infer<typeof payment>;
export type Invoice = z.infer<typeof invoice>;
export type Subscription = z.infer<typeof subscription>;
export type CreateRefundRequest = z.infer<typeof createRefundRequest>;
