import { type ClientOptions, callService } from "@proofdesk/service";
import {
  type CreateRefundRequest,
  type Invoice,
  invoiceList,
  type Refund,
  refundResult,
  type Subscription,
  subscriptionList,
} from "./api.ts";

export type BillingClient = ReturnType<typeof createBillingClient>;

export function createBillingClient(options: ClientOptions) {
  return {
    async listSubscriptions(customerId: string): Promise<Subscription[]> {
      const path = `/customers/${encodeURIComponent(customerId)}/subscriptions`;
      const result = await callService(options, subscriptionList, { method: "GET", path });
      return result.subscriptions;
    },

    async listInvoices(customerId: string, filter: { number?: string } = {}): Promise<Invoice[]> {
      const query =
        filter.number === undefined ? "" : `?number=${encodeURIComponent(filter.number)}`;
      const path = `/customers/${encodeURIComponent(customerId)}/invoices${query}`;
      const result = await callService(options, invoiceList, { method: "GET", path });
      return result.invoices;
    },

    /** Safe to retry with the same key: the refund is issued at most once. */
    async createRefund(request: CreateRefundRequest, idempotencyKey: string): Promise<Refund> {
      const result = await callService(options, refundResult, {
        method: "POST",
        path: "/refunds",
        body: request,
        headers: { "idempotency-key": idempotencyKey },
      });
      return result.refund;
    },
  };
}
