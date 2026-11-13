import { InMemorySpanExporter } from "@opentelemetry/sdk-trace";
import { describe, expect, it } from "vitest";
import {
  type InspectedModelCall,
  noInspection,
  projectFor,
  startInspection,
  ticketTraceIds,
} from "./inspection.ts";

const at = (seconds: number) => new Date(Date.UTC(2026, 10, 14, 10, 0, seconds));
const usage = { inputTokens: 900, outputTokens: 60, cacheReadTokens: 400, cacheWriteTokens: 100 };

function setup() {
  const exporters = new Map<string, InMemorySpanExporter>();
  const inspection = startInspection({
    exporter: (project) => {
      const exporter = new InMemorySpanExporter();
      exporters.set(project, exporter);
      return exporter;
    },
  });
  return {
    inspection,
    /** Flushes, then returns what each project received. */
    async received() {
      await inspection.flush();
      return new Map(
        [...exporters].map(([project, exporter]) => [
          project,
          exporter.getFinishedSpans().map((span) => ({
            name: span.name,
            traceId: span.spanContext().traceId,
            spanId: span.spanContext().spanId,
            parent: span.parentSpanContext?.spanId,
            attributes: span.attributes,
          })),
        ]),
      );
    },
  };
}

const call = (overrides: Partial<InspectedModelCall> = {}): InspectedModelCall => ({
  tenantId: "ten_a",
  ticketId: "tkt_1",
  requestedModel: "claude-sonnet-5-5",
  model: "claude-haiku-5-5",
  system: "You resolve support tickets.",
  messages: [
    { role: "user", content: [{ type: "text", text: "I was charged twice." }] },
    {
      role: "assistant",
      content: [
        { type: "opaque", provider: "anthropic", data: { type: "thinking" } },
        { type: "tool_use", id: "toolu_1", name: "list_invoices", input: {} },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", toolUseId: "toolu_1", content: '{"invoices":[]}' }],
    },
  ],
  tools: [{ name: "list_invoices", description: "Lists invoices.", inputSchema: {} }],
  output: [{ type: "text", text: "There are no invoices on your account." }],
  stopReason: "end_turn",
  usage,
  startedAt: at(1),
  endedAt: at(3),
  ...overrides,
});

describe("the inspection store", () => {
  it("sends nothing unless it is configured", () => {
    expect(startInspection({})).toBe(noInspection);
    expect(startInspection({ endpoint: undefined, apiKey: "unused" })).toBe(noInspection);
  });

  it("records a model call as a conversation a person can read", async () => {
    const { inspection, received } = setup();
    inspection.modelCall(call());
    const [span] = (await received()).get(projectFor("ten_a")) ?? [];

    expect(span?.attributes).toMatchObject({
      "openinference.span.kind": "LLM",
      "session.id": "tkt_1",
      // The model that answered, and the one that was asked for.
      "llm.model_name": "claude-haiku-5-5",
      "llm.invocation_parameters": '{"requested_model":"claude-sonnet-5-5"}',
      "llm.input_messages.0.message.role": "system",
      "llm.input_messages.0.message.content": "You resolve support tickets.",
      "llm.input_messages.1.message.role": "user",
      "llm.input_messages.1.message.content": "I was charged twice.",
      "llm.input_messages.2.message.role": "assistant",
      "llm.input_messages.2.message.tool_calls.0.tool_call.function.name": "list_invoices",
      "llm.input_messages.3.message.role": "tool",
      "llm.input_messages.3.message.tool_call_id": "toolu_1",
      "llm.input_messages.3.message.content": '{"invoices":[]}',
      "llm.output_messages.0.message.role": "assistant",
      "llm.output_messages.0.message.content": "There are no invoices on your account.",
      "llm.token_count.prompt": 1400,
      "llm.token_count.completion": 60,
      "llm.token_count.total": 1460,
      "llm.token_count.prompt_details.cache_read": 400,
    });
    // A provider's private blocks are not something a reader can use.
    expect(JSON.stringify(span?.attributes)).not.toContain("thinking");
  });

  it("puts a ticket's model calls, tool calls and summary in one trace under one root", async () => {
    const { inspection, received } = setup();
    inspection.modelCall(call());
    inspection.toolCall({
      tenantId: "ten_a",
      ticketId: "tkt_1",
      name: "create_refund",
      input: { paymentId: "pay_1", amountCents: 8700 },
      verdict: "deny",
      output: "Not allowed by policy: The payment is older than the refund window.",
      failed: true,
      startedAt: at(4),
      endedAt: at(5),
    });
    inspection.ticket({
      tenantId: "ten_a",
      ticketId: "tkt_1",
      category: "refund",
      input: "Refund please\n\nI was charged twice.",
      output: "I could not refund this charge.",
      outcome: "refused",
      reason: "outside_window",
      violations: [],
      versions: { model: "claude-sonnet-5-5", prompt: "2026-11-13.5" },
      startedAt: at(0),
      endedAt: at(6),
    });
    const spans = (await received()).get(projectFor("ten_a")) ?? [];
    const ids = ticketTraceIds("tkt_1");
    const root = spans.find((span) => span.name === "ticket");

    expect(spans).toHaveLength(3);
    expect(spans.every((span) => span.traceId === ids.traceId)).toBe(true);
    expect(root).toMatchObject({ spanId: ids.spanId, parent: undefined });
    expect(spans.filter((span) => span !== root).every((span) => span.parent === ids.spanId)).toBe(
      true,
    );
    expect(root?.attributes).toMatchObject({
      "openinference.span.kind": "AGENT",
      "input.value": "Refund please\n\nI was charged twice.",
      "output.value": "I could not refund this charge.",
    });
    expect(JSON.parse(String(root?.attributes.metadata))).toMatchObject({
      outcome: "refused",
      reason: "outside_window",
      prompt: "2026-11-13.5",
    });
    const tool = spans.find((span) => span.name === "create_refund");
    expect(tool?.attributes).toMatchObject({
      "openinference.span.kind": "TOOL",
      "input.value": '{"paymentId":"pay_1","amountCents":8700}',
      metadata: '{"verdict":"deny"}',
    });
  });

  it("keeps each company's conversations in its own project", async () => {
    const { inspection, received } = setup();
    inspection.modelCall(call({ tenantId: "ten_a", ticketId: "tkt_a" }));
    inspection.modelCall(call({ tenantId: "ten_b", ticketId: "tkt_b" }));
    const projects = await received();

    expect([...projects.keys()].sort()).toEqual(["proofdesk-ten_a", "proofdesk-ten_b"]);
    for (const [project, spans] of projects) {
      expect(spans.map((span) => span.attributes["session.id"])).toEqual([
        project === "proofdesk-ten_a" ? "tkt_a" : "tkt_b",
      ]);
    }
  });
});
