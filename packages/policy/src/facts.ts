import { z } from "zod";

/**
 * The parts of a customer's billing records that refund policy depends on.
 * Records read from another system are checked against this before a
 * decision is made on them: a policy must not decide on a malformed record.
 */
export const invoiceRecords = z.array(
  z.object({
    payments: z.array(
      z.object({
        id: z.string(),
        status: z.string(),
        createdAt: z.iso.datetime(),
        amountCents: z.number().int(),
        refundedCents: z.number().int(),
        refunds: z.array(z.object({ reason: z.string(), createdAt: z.iso.datetime() })),
      }),
    ),
  }),
);

export type InvoiceRecords = z.infer<typeof invoiceRecords>;

export type RefundFacts = {
  paymentFound: boolean;
  daysSincePayment: number;
  paymentAmountCents: number;
  isLaterDuplicate: boolean;
  invoiceDisputed: boolean;
  goodwillUsed: boolean;
};

const DAY_MS = 86_400_000;
const wholeDays = (from: string, to: Date) =>
  Math.floor((to.getTime() - Date.parse(from)) / DAY_MS);

/**
 * Establishes the facts about one payment from the billing records. The
 * policy layer calls this itself, so a refund is judged on what the records
 * say and not on what the model, or the ticket, claims.
 */
export function refundFacts(invoices: InvoiceRecords, paymentId: string, now: Date): RefundFacts {
  const goodwillUsed = invoices.some((invoice) =>
    invoice.payments.some((payment) =>
      payment.refunds.some(
        (refund) => refund.reason === "customer_request" && wholeDays(refund.createdAt, now) <= 365,
      ),
    ),
  );

  for (const invoice of invoices) {
    const payment = invoice.payments.find((candidate) => candidate.id === paymentId);
    if (!payment) continue;
    const succeeded = invoice.payments
      .filter((candidate) => candidate.status === "succeeded")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return {
      paymentFound: true,
      daysSincePayment: Math.max(0, wholeDays(payment.createdAt, now)),
      paymentAmountCents: payment.amountCents,
      isLaterDuplicate: succeeded.findIndex((candidate) => candidate.id === paymentId) > 0,
      invoiceDisputed: invoice.payments.some((candidate) => candidate.status === "disputed"),
      goodwillUsed,
    };
  }
  return {
    paymentFound: false,
    daysSincePayment: 0,
    paymentAmountCents: 0,
    isLaterDuplicate: false,
    invoiceDisputed: false,
    goodwillUsed,
  };
}
