import type { ModelProvider, ModelRequest, ModelResponse, PriceTable } from "@proofdesk/gateway";

// A stand-in for the model that needs no state and no network, so it gives
// the same answers in any process. It follows a few fixed rules:
//
//   A plan-change ticket that names a number of seats: change the plan.
//   A refund ticket with an invoice that was paid twice: refund the later
//   payment, unless the ticket does not say which charge it is about, in
//   which case ask.
//
// The worker loads it through MODEL_PROVIDER_MODULE, in tests and in the
// local stack when no model key is configured.

export const prices: PriceTable = {
  "rule-model": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

type Seen = {
  invoices?: { number: string; payments: { id: string; amountCents: number; status: string }[] }[];
  refund?: { amountCents: number };
  subscriptions?: { id: string; seats: number; plan: { code: string } }[];
  change?: unknown;
};

/** Everything the customer wrote: the ticket and any later replies. */
const customerText = (request: ModelRequest) =>
  request.messages
    .flatMap((message) =>
      message.role === "user"
        ? message.content.flatMap((block) => (block.type === "text" ? [block.text] : []))
        : [],
    )
    .join("\n");

function toolResults(request: ModelRequest): Seen[] {
  return request.messages.flatMap((message) =>
    message.role === "user"
      ? message.content.flatMap((block) => {
          if (block.type !== "tool_result") return [];
          try {
            return [JSON.parse(block.content) as Seen];
          } catch {
            return [];
          }
        })
      : [],
  );
}

const provider: ModelProvider = {
  name: "rule",
  async complete(request): Promise<ModelResponse> {
    const results = toolResults(request);
    const invoice = results
      .flatMap((result) => result.invoices ?? [])
      .find((candidate) => candidate.payments.filter((p) => p.status === "succeeded").length > 1);
    const refund = results.find((result) => result.refund)?.refund;
    const id = `rule_${request.messages.length}`;

    const said = customerText(request);
    let name = "list_invoices";
    let input: unknown = {};

    if (request.tools?.some((tool) => tool.name === "change_plan")) {
      const [subscription] = results.flatMap((result) => result.subscriptions ?? []);
      const seats = /\bto (\d+)\b/.exec(said)?.[1];
      if (!subscription) {
        name = "list_subscriptions";
      } else if (results.some((result) => result.change)) {
        name = "resolve_ticket";
        input = {
          outcome: "plan_changed",
          reasonCode: "plan_changed",
          reply: `Your plan now has ${seats} seats, from the next renewal.`,
        };
      } else if (seats) {
        name = "change_plan";
        input = {
          subscriptionId: subscription.id,
          planCode: subscription.plan.code,
          seats: Number(seats),
        };
      } else {
        name = "resolve_ticket";
        input = {
          outcome: "needs_clarification",
          reasonCode: "request_unclear",
          reply: "How many seats would you like?",
        };
      }
    } else if (refund && invoice) {
      name = "resolve_ticket";
      input = {
        outcome: "refunded",
        reasonCode: "duplicate_charge",
        reply: `I have refunded $${(refund.amountCents / 100).toFixed(2)} for invoice ${invoice.number}.`,
      };
    } else if (invoice && !/twice|duplicate|second|double/i.test(said)) {
      // The ticket does not say what is wrong. Ask, as a careful agent would.
      name = "resolve_ticket";
      input = {
        outcome: "needs_clarification",
        reasonCode: "invoice_unclear",
        reply: `Which charge do you mean? Invoice ${invoice.number} shows two payments.`,
      };
    } else if (invoice) {
      const duplicate = invoice.payments.filter((p) => p.status === "succeeded").at(-1);
      name = "create_refund";
      input = {
        paymentId: duplicate?.id,
        amountCents: duplicate?.amountCents,
        reason: "duplicate_charge",
      };
    } else if (results.length > 0) {
      name = "resolve_ticket";
      input = {
        outcome: "refused",
        reasonCode: "no_duplicate_found",
        reply: "I found no duplicate charge.",
      };
    }

    return {
      model: "rule-model",
      stopReason: "tool_use",
      content: [{ type: "tool_use", id, name, input }],
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  },
};

export default provider;
