import { describe, expect, it } from "vitest";
import { ProviderError } from "./errors.ts";
import { MockProvider, textResponse, toolUseResponse } from "./mock.ts";
import type { CallContext, ModelRequest } from "./types.ts";

const context: CallContext = { tenantId: "tenant-a", ticketId: "ticket-1" };

function request(text: string): ModelRequest {
  return {
    model: "mock-model",
    maxTokens: 1024,
    messages: [{ role: "user", content: [{ type: "text", text }] }],
  };
}

describe("MockProvider", () => {
  it("returns scripted steps in order", async () => {
    const provider = new MockProvider([
      toolUseResponse({ id: "call-1", name: "get_invoices", input: { customerId: "c-1" } }),
      textResponse("Refund issued."),
    ]);

    const first = await provider.complete(request("refund please"), context);
    const second = await provider.complete(request("tool result"), context);

    expect(first.stopReason).toBe("tool_use");
    expect(first.content).toEqual([
      { type: "tool_use", id: "call-1", name: "get_invoices", input: { customerId: "c-1" } },
    ]);
    expect(second.stopReason).toBe("end_turn");
    expect(provider.remaining).toBe(0);
  });

  it("throws when called past the end of its script", async () => {
    const provider = new MockProvider([textResponse("only one")]);
    await provider.complete(request("first"), context);

    await expect(provider.complete(request("second"), context)).rejects.toThrow(/exhausted/);
  });

  it("throws scripted errors", async () => {
    const error = new ProviderError("mock", "overloaded", "try again later");
    const provider = new MockProvider([error]);

    await expect(provider.complete(request("hello"), context)).rejects.toBe(error);
  });

  it("lets a step compute its response from the request", async () => {
    const provider = new MockProvider([(req) => textResponse(`model was ${req.model}`)]);

    const result = await provider.complete(request("hello"), context);

    expect(result.content).toEqual([{ type: "text", text: "model was mock-model" }]);
  });

  it("records a snapshot of each request", async () => {
    const provider = new MockProvider([textResponse("ok")]);
    const req = request("original");

    await provider.complete(req, context);
    req.messages.push({ role: "user", content: [{ type: "text", text: "added later" }] });

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.request.messages).toHaveLength(1);
    expect(provider.calls[0]?.context).toBe(context);
  });

  it("refuses to run once the caller has aborted", async () => {
    const provider = new MockProvider([textResponse("never returned")]);
    const controller = new AbortController();
    controller.abort();

    await expect(
      provider.complete(request("hello"), { ...context, signal: controller.signal }),
    ).rejects.toThrow();
    expect(provider.remaining).toBe(1);
  });
});

describe("ProviderError", () => {
  it("marks transient failures as retryable", () => {
    expect(new ProviderError("mock", "rate_limited", "slow down").retryable).toBe(true);
    expect(new ProviderError("mock", "timeout", "too slow").retryable).toBe(true);
  });

  it("marks caller mistakes as not retryable", () => {
    expect(new ProviderError("mock", "invalid_request", "bad schema").retryable).toBe(false);
    expect(new ProviderError("mock", "unauthorized", "bad key").retryable).toBe(false);
  });
});
