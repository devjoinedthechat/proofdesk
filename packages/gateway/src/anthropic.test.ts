import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { createAnthropicProvider, toStrictSchema } from "./anthropic.ts";
import { ProviderError } from "./errors.ts";
import type { CallContext, ModelRequest } from "./types.ts";

// These tests run the real SDK against a fake HTTP layer. They check what is
// sent on the wire and how responses and failures are translated. They do not
// prove the live API accepts the request; only a real call can.

const context: CallContext = { tenantId: "tenant-a", ticketId: "ticket-1" };

type Captured = { url: string; headers: Headers; body: Record<string, unknown> };

function fakeApi(respond: () => Response) {
  const calls: Captured[] = [];
  const client = new Anthropic({
    apiKey: "test-key",
    maxRetries: 0,
    fetch: async (url, init) => {
      calls.push({
        url: String(url),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      });
      return respond();
    },
  });
  return { provider: createAnthropicProvider({ client }), calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const message = (overrides: Record<string, unknown> = {}) => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5-5",
  content: [{ type: "text", text: "Done." }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80 },
  ...overrides,
});

const thinking = { type: "thinking", thinking: "", signature: "sig-abc" };

const request: ModelRequest = {
  model: "claude-sonnet-5-5",
  system: "You resolve support tickets.",
  maxTokens: 4096,
  effort: "medium",
  tools: [
    {
      name: "list_invoices",
      description: "Lists invoices.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      strict: true,
    },
  ],
  messages: [
    { role: "user", content: [{ type: "text", text: "Refund please" }] },
    {
      role: "assistant",
      content: [
        { type: "opaque", provider: "anthropic", data: thinking },
        { type: "opaque", provider: "other-provider", data: { anything: true } },
        { type: "tool_use", id: "toolu_1", name: "list_invoices", input: {} },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", toolUseId: "toolu_1", content: "[]", isError: true }],
    },
  ],
};

describe("toStrictSchema", () => {
  it("closes every object and drops the constraints strict mode cannot enforce", () => {
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        amountCents: { type: "integer", exclusiveMinimum: 0, description: "In cents." },
        // A property may be named like a keyword. It is still a property.
        minimum: { type: "string", minLength: 2, maxLength: 300 },
        lines: {
          type: "array",
          minItems: 1,
          items: { type: "object", properties: { seats: { type: "integer", maximum: 500 } } },
        },
        reason: { type: "string", enum: ["duplicate_charge", "customer_request"] },
      },
      required: ["amountCents"],
    };

    expect(toStrictSchema(schema)).toEqual({
      type: "object",
      properties: {
        amountCents: { type: "integer", description: "In cents." },
        minimum: { type: "string" },
        lines: {
          type: "array",
          items: {
            type: "object",
            properties: { seats: { type: "integer" } },
            additionalProperties: false,
          },
        },
        reason: { type: "string", enum: ["duplicate_charge", "customer_request"] },
      },
      required: ["amountCents"],
      additionalProperties: false,
    });
    // The caller's schema is not changed: its owner still validates against all of it.
    expect(schema.properties.amountCents).toHaveProperty("exclusiveMinimum", 0);
  });
});

describe("createAnthropicProvider", () => {
  it("sends a strict tool's schema in strict form and any other tool's as it is", async () => {
    const { provider, calls } = fakeApi(() => json(message()));
    const inputSchema = {
      type: "object",
      properties: { seats: { type: "integer", minimum: 1 } },
    };
    await provider.complete(
      {
        ...request,
        tools: [
          { name: "strict_tool", description: "", inputSchema, strict: true },
          { name: "plain_tool", description: "", inputSchema },
        ],
      },
      context,
    );

    expect(calls[0]?.body).toHaveProperty("tools", [
      {
        name: "strict_tool",
        description: "",
        strict: true,
        input_schema: {
          type: "object",
          properties: { seats: { type: "integer" } },
          additionalProperties: false,
        },
      },
      { name: "plain_tool", description: "", input_schema: inputSchema },
    ]);
  });

  it("sends the request in the Messages API shape", async () => {
    const { provider, calls } = fakeApi(() => json(message()));
    await provider.complete(request, context);
    const [call] = calls;

    expect(call?.url).toContain("/v1/messages");
    expect(call?.body).toMatchObject({
      model: "claude-sonnet-5-5",
      max_tokens: 4096,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      system: [
        {
          type: "text",
          text: "You resolve support tickets.",
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: [{ name: "list_invoices", strict: true, input_schema: { type: "object" } }],
    });
    expect(call?.body).not.toHaveProperty("tool_choice");
    expect(call?.body).not.toHaveProperty("temperature");
  });

  it("replays its own opaque blocks unchanged and drops another provider's", async () => {
    const { provider, calls } = fakeApi(() => json(message()));
    await provider.complete(request, context);

    const messages = calls[0]?.body.messages as { role: string; content: unknown[] }[];
    expect(messages[1]?.content).toEqual([
      thinking,
      { type: "tool_use", id: "toolu_1", name: "list_invoices", input: {} },
    ]);
    expect(messages[2]?.content).toEqual([
      { type: "tool_result", tool_use_id: "toolu_1", content: "[]", is_error: true },
    ]);
  });

  it("asks for a server-side fallback on models that support one, and not on Haiku", async () => {
    const sonnet = fakeApi(() => json(message()));
    await sonnet.provider.complete(request, context);
    expect(sonnet.calls[0]?.body.fallbacks).toBe("default");
    expect(sonnet.calls[0]?.headers.get("anthropic-beta")).toContain(
      "server-side-fallback-2026-07-01",
    );

    const haiku = fakeApi(() => json(message({ model: "claude-haiku-5-5" })));
    await haiku.provider.complete({ ...request, model: "claude-haiku-5-5" }, context);
    expect(haiku.calls[0]?.body).not.toHaveProperty("fallbacks");
    expect(haiku.calls[0]?.headers.get("anthropic-beta")).toBeNull();
  });

  it("translates the response, keeping blocks it does not understand as opaque", async () => {
    const { provider } = fakeApi(() =>
      json(
        message({
          stop_reason: "tool_use",
          content: [
            thinking,
            { type: "text", text: "Let me check." },
            { type: "tool_use", id: "toolu_2", name: "list_invoices", input: { a: 1 } },
          ],
        }),
      ),
    );

    const response = await provider.complete(request, context);

    expect(response).toEqual({
      model: "claude-sonnet-5-5",
      stopReason: "tool_use",
      content: [
        { type: "opaque", provider: "anthropic", data: thinking },
        { type: "text", text: "Let me check." },
        { type: "tool_use", id: "toolu_2", name: "list_invoices", input: { a: 1 } },
      ],
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, cacheWriteTokens: 0 },
    });
  });

  it("reports a refusal as a stop reason, not an error", async () => {
    const { provider } = fakeApi(() =>
      json(
        message({
          content: [],
          stop_reason: "refusal",
          stop_details: { type: "refusal", category: "general_harms", explanation: null },
        }),
      ),
    );
    expect((await provider.complete(request, context)).stopReason).toBe("refusal");
  });

  it.each([
    [429, "rate_limited", true],
    [529, "overloaded", true],
    [500, "unavailable", true],
    [408, "timeout", true],
    [400, "invalid_request", false],
    [401, "unauthorized", false],
    [403, "unauthorized", false],
  ] as const)("maps HTTP %i to %s", async (status, kind, retryable) => {
    const { provider } = fakeApi(() =>
      json({ type: "error", error: { type: "api_error", message: "nope" } }, status),
    );
    const error = await provider.complete(request, context).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind, retryable, provider: "anthropic" });
  });

  it("maps a network failure to unavailable", async () => {
    const client = new Anthropic({
      apiKey: "test-key",
      maxRetries: 0,
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    const error = await createAnthropicProvider({ client })
      .complete(request, context)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: "unavailable", retryable: true });
  });
});
