import type { ModelProvider, ModelRequest, ModelResponse, PriceTable } from "@proofdesk/gateway";

// A stand-in for the model that needs no state and no network, so it gives
// the same answers in any process. It handles exactly one case: find the
// invoice that was paid twice, refund the later payment, and resolve.
// The worker loads it through MODEL_PROVIDER_MODULE in tests.

export const prices: PriceTable = {
  "rule-model": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

type Seen = {
  invoices?: { number: string; payments: { id: string; amountCents: number; status: string }[] }[];
  refund?: { amountCents: number };
};

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

    let name = "list_invoices";
    let input: unknown = {};
    if (refund && invoice) {
      name = "resolve_ticket";
      input = {
        outcome: "refunded",
        reasonCode: "duplicate_charge",
        reply: `I have refunded $${(refund.amountCents / 100).toFixed(2)} for invoice ${invoice.number}.`,
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
