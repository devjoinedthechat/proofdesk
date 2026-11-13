import {
  type Message,
  type MockStep,
  type ModelRequest,
  toolUseResponse,
} from "@proofdesk/gateway";

// Building blocks for a scripted stand-in model. Tests use them to drive the
// agent through a known sequence of tool calls without calling a real model.

export type SeenInvoice = {
  number: string;
  payments: { id: string; amountCents: number; status: string }[];
};

/** The invoices returned by the most recent list_invoices call in the conversation. */
export function invoicesSeen(request: ModelRequest): SeenInvoice[] {
  const results = request.messages.flatMap((message: Message) =>
    message.role === "user" ? message.content.filter((block) => block.type === "tool_result") : [],
  );
  for (const result of results.reverse()) {
    try {
      const parsed = JSON.parse(result.content);
      if (parsed.invoices) return parsed.invoices;
    } catch {
      // Not every tool result is JSON.
    }
  }
  return [];
}

let sequence = 0;

export const call = (name: string, input: unknown) =>
  toolUseResponse({ id: `call_${++sequence}`, name, input });

export const listInvoices = (invoiceNumber?: string) =>
  call("list_invoices", invoiceNumber ? { invoiceNumber } : {});

export const resolve = (outcome: string, reasonCode: string, reply: string) =>
  call("resolve_ticket", { outcome, reasonCode, reply });

/** Refunds the last successful payment on the first invoice seen. */
export const refundLastPayment =
  (reason: string): MockStep =>
  (request) => {
    const [invoice] = invoicesSeen(request);
    const payment = invoice?.payments
      .filter((candidate) => candidate.status === "succeeded")
      .at(-1);
    return call("create_refund", {
      paymentId: payment?.id,
      amountCents: payment?.amountCents,
      reason,
    });
  };

/** Resolves with a reply built from the first invoice seen. */
export const resolveWith =
  (outcome: string, reasonCode: string, reply: (invoiceNumber: string) => string): MockStep =>
  (request) =>
    resolve(outcome, reasonCode, reply(invoicesSeen(request)[0]?.number ?? ""));
