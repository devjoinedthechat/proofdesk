import { describe, expect, it } from "vitest";
import { ProviderError } from "./errors.ts";
import {
  BudgetExceededError,
  type CallRecord,
  createGateway,
  createMemoryLedger,
} from "./gateway.ts";
import { MockProvider, type MockStep, textResponse } from "./mock.ts";
import { costMicros } from "./pricing.ts";
import type { CallContext, ModelRequest } from "./types.ts";

const context: CallContext = { tenantId: "tenant-a", ticketId: "ticket-1" };
const request: ModelRequest = {
  model: "main-model",
  maxTokens: 1024,
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
};
const prices = {
  "main-model": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "backup-model": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};
const usage = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 };
const answer = (text: string, model = "main-model") => textResponse(text, { model, usage });
const down = (kind: "overloaded" | "rate_limited" | "invalid_request" = "overloaded") =>
  new ProviderError("mock", kind, kind);

function setup(
  primary: MockStep[],
  backup?: MockStep[],
  limits = { perTicketMicros: 50_000, perTenantMicros: 1_000_000 },
) {
  const records: CallRecord[] = [];
  const sleeps: number[] = [];
  const ledger = createMemoryLedger();
  const primaryProvider = new MockProvider(primary, "primary");
  const backupProvider = backup ? new MockProvider(backup, "backup") : undefined;
  const gateway = createGateway({
    routes: backupProvider
      ? [
          { provider: primaryProvider },
          { provider: backupProvider, models: { "main-model": "backup-model" } },
        ]
      : [{ provider: primaryProvider }],
    prices,
    ledger,
    limits,
    onCall: (record) => records.push(record),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 1,
  });
  return { gateway, records, sleeps, ledger, primaryProvider, backupProvider };
}

describe("pricing", () => {
  it("prices a call in whole micro-dollars", () => {
    const price = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };
    // 1,000 input tokens at $2 per million is $0.002, which is 2,000 micro-dollars.
    expect(costMicros(price, { ...usage, outputTokens: 0 })).toBe(2_000);
    expect(costMicros(price, usage)).toBe(3_000);
    expect(
      costMicros(price, {
        inputTokens: 1,
        outputTokens: 0,
        cacheReadTokens: 1,
        cacheWriteTokens: 0,
      }),
    ).toBe(3);
  });
});

describe("createGateway", () => {
  it("passes a call through and records its cost against the ticket and the tenant", async () => {
    const { gateway, records, ledger } = setup([answer("hi")]);

    const response = await gateway.complete(request, context);

    expect(response.content).toEqual([{ type: "text", text: "hi" }]);
    expect(await ledger.spent("ticket:tenant-a:ticket-1")).toBe(3_000);
    expect(await ledger.spent("tenant:tenant-a")).toBe(3_000);
    expect(records).toMatchObject([
      {
        provider: "primary",
        requestedModel: "main-model",
        model: "main-model",
        attempt: 1,
        costMicros: 3_000,
      },
    ]);
  });

  it("waits as long as the provider asked, within reason", async () => {
    const limited = (retryAfterMs: number) =>
      new ProviderError("mock", "rate_limited", "slow down", { retryAfterMs });
    const { gateway, sleeps } = setup([limited(4000), limited(600_000), answer("ok")]);

    await gateway.complete(request, context);

    expect(sleeps).toEqual([4000, 30_000]);
  });

  it("retries a transient failure with growing delays", async () => {
    const { gateway, sleeps, records } = setup([
      down(),
      down("rate_limited"),
      answer("third time"),
    ]);

    const response = await gateway.complete(request, context);

    expect(response.content).toEqual([{ type: "text", text: "third time" }]);
    expect(sleeps).toEqual([500, 1000]);
    expect(records.map((record) => record.error ?? "ok")).toEqual([
      "overloaded",
      "rate_limited",
      "ok",
    ]);
  });

  it("does not retry a request the provider called invalid", async () => {
    const { gateway, primaryProvider, sleeps } = setup([down("invalid_request"), answer("unused")]);

    await expect(gateway.complete(request, context)).rejects.toMatchObject({
      kind: "invalid_request",
    });
    expect(primaryProvider.calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("moves to the backup provider, with its own model, once the primary stays down", async () => {
    const { gateway, records, backupProvider, ledger } = setup(
      [down(), down(), down()],
      [answer("from backup", "backup-model")],
    );

    const response = await gateway.complete(request, context);

    expect(response.model).toBe("backup-model");
    expect(backupProvider?.calls[0]?.request.model).toBe("backup-model");
    expect(records.map((record) => record.provider)).toEqual([
      "primary",
      "primary",
      "primary",
      "backup",
    ]);
    // Priced at the backup model's rate: 1,000 x $1 + 100 x $5.
    expect(await ledger.spent("ticket:tenant-a:ticket-1")).toBe(1_500);
  });

  it("moves to another model of the same provider, with the conversation unchanged", async () => {
    const thinking = { type: "opaque" as const, provider: "one", data: { signature: "abc" } };
    const conversation: ModelRequest = {
      ...request,
      messages: [
        ...request.messages,
        { role: "assistant", content: [thinking, { type: "text", text: "Let me check." }] },
        { role: "user", content: [{ type: "text", text: "Thanks." }] },
      ],
    };
    const provider = new MockProvider(
      [down(), down("rate_limited"), down(), answer("from the other model", "backup-model")],
      "one",
    );
    const records: CallRecord[] = [];
    const gateway = createGateway({
      routes: [{ provider }, { provider, models: { "main-model": "backup-model" } }],
      prices,
      ledger: createMemoryLedger(),
      limits: { perTicketMicros: 50_000, perTenantMicros: 1_000_000 },
      onCall: (record) => records.push(record),
      sleep: async () => {},
    });

    const response = await gateway.complete(conversation, context);

    expect(response.model).toBe("backup-model");
    expect(records.map((record) => record.sentModel)).toEqual([
      "main-model",
      "main-model",
      "main-model",
      "backup-model",
    ]);
    // Nothing is removed for the other model: what it cannot read is for the
    // provider to leave out, and the history must be intact for the way back.
    expect(provider.calls[3]?.request).toEqual({ ...conversation, model: "backup-model" });
  });

  it("fails with the last error when every provider is down", async () => {
    const { gateway } = setup([down(), down(), down()], [down(), down(), down("rate_limited")]);
    await expect(gateway.complete(request, context)).rejects.toMatchObject({
      kind: "rate_limited",
    });
  });

  it("refuses a call once the ticket's budget is spent, without calling the model", async () => {
    const { gateway, primaryProvider } = setup(
      [answer("one"), answer("two"), answer("never")],
      undefined,
      { perTicketMicros: 6_000, perTenantMicros: 1_000_000 },
    );
    await gateway.complete(request, context);
    await gateway.complete(request, context);

    const error = await gateway.complete(request, context).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BudgetExceededError);
    expect(error).toMatchObject({ scope: "ticket", spentMicros: 6_000 });
    expect(primaryProvider.calls).toHaveLength(2);
  });

  it("keeps one ticket's spend from blocking another, until the tenant's budget is spent", async () => {
    const { gateway } = setup([answer("a"), answer("b"), answer("never")], undefined, {
      perTicketMicros: 3_000,
      perTenantMicros: 6_000,
    });
    await gateway.complete(request, context);
    await gateway.complete(request, { ...context, ticketId: "ticket-2" });

    const error = await gateway
      .complete(request, { ...context, ticketId: "ticket-3" })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ scope: "tenant" });
  });

  it("does not let retries run past the budget", async () => {
    // Each failed attempt is free, but the budget is checked before every attempt.
    const { gateway, ledger } = setup([down(), answer("ok")], undefined, {
      perTicketMicros: 1,
      perTenantMicros: 1_000_000,
    });
    await ledger.add("ticket:tenant-a:ticket-1", 1);
    await expect(gateway.complete(request, context)).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it("refuses a model that has no price", async () => {
    const { gateway, primaryProvider } = setup([answer("unused")]);
    await expect(
      gateway.complete({ ...request, model: "unpriced-model" }, context),
    ).rejects.toMatchObject({ kind: "invalid_request" });
    expect(primaryProvider.calls).toHaveLength(0);
  });

  it("stops when the caller aborts", async () => {
    const { gateway, primaryProvider } = setup([answer("unused")]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      gateway.complete(request, { ...context, signal: controller.signal }),
    ).rejects.toThrow();
    expect(primaryProvider.calls).toHaveLength(0);
  });
});
