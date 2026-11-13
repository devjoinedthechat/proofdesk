import { describe, expect, it } from "vitest";
import { createFaultInjector, modelOutage } from "./faults.ts";
import { createGateway, createMemoryLedger } from "./gateway.ts";
import { MockProvider, textResponse } from "./mock.ts";
import type { ModelRequest } from "./types.ts";

const context = { tenantId: "tenant-a", ticketId: "ticket-1" };
const ask = (text: string, model = "main-model"): ModelRequest => ({
  model,
  maxTokens: 100,
  messages: [{ role: "user", content: [{ type: "text", text }] }],
});
const price = { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 };

describe("modelOutage", () => {
  it("fails about the given share of one model's calls and none of another's", () => {
    const fails = modelOutage({ model: "main-model", rate: 0.4 });
    const failed = Array.from({ length: 500 }, (_, index) => fails(ask(`question ${index}`)));

    const share = failed.filter((kind) => kind === "overloaded").length / failed.length;
    expect(share).toBeGreaterThan(0.3);
    expect(share).toBeLessThan(0.5);
    expect(fails(ask("question 1", "backup-model"))).toBeUndefined();
  });

  it("decides the same way for the same request, and differently for another seed", () => {
    const requests = Array.from({ length: 200 }, (_, index) => ask(`question ${index}`));
    const decide = (seed: number) =>
      requests.map((request) => modelOutage({ model: "main-model", rate: 0.5, seed })(request));

    expect(decide(1)).toEqual(decide(1));
    expect(decide(1)).not.toEqual(decide(2));
  });
});

describe("createFaultInjector", () => {
  it("fails a call without making it, so the gateway moves to the backup model", async () => {
    const inner = new MockProvider([textResponse("from backup", { model: "backup-model" })]);
    const provider = createFaultInjector(inner, (request) =>
      request.model === "main-model" ? "overloaded" : undefined,
    );
    const gateway = createGateway({
      routes: [{ provider }, { provider, models: { "main-model": "backup-model" } }],
      prices: { "main-model": price, "backup-model": price },
      ledger: createMemoryLedger(),
      limits: { perTicketMicros: 1_000, perTenantMicros: 1_000 },
      sleep: async () => {},
    });

    const response = await gateway.complete(ask("hello"), context);

    expect(response.model).toBe("backup-model");
    expect(provider.injected).toBe(3);
    expect(inner.calls.map((call) => call.request.model)).toEqual(["backup-model"]);
  });
});
