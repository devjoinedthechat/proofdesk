import {
  BudgetExceededError,
  type Message,
  MockProvider,
  type MockStep,
  type ModelResponse,
  textResponse,
  toolUseResponse,
} from "@proofdesk/gateway";
import { describe, expect, it } from "vitest";
import { checkResolution, ungroundedAmounts } from "./guards.ts";
import {
  type AgentRun,
  type AgentState,
  initialState,
  resumeWith,
  runAgent,
  settleNext,
} from "./loop.ts";
import type { AgentTool, ToolCallRecord, Verdict } from "./tools.ts";
import { withSystemIdempotency } from "./tools.ts";

const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

const resolve = (outcome = "refused", reasonCode = "outside_window", reply = "Sorry, no.") =>
  toolUseResponse({ id: "res", name: "resolve_ticket", input: { outcome, reasonCode, reply } });

const callTool = (name: string, input: unknown = {}, id = `call-${name}`) =>
  toolUseResponse({ id, name, input });

const many = (...calls: { id: string; name: string; input: unknown }[]): ModelResponse => ({
  model: "mock-model",
  stopReason: "tool_use",
  usage,
  content: calls.map((call) => ({ type: "tool_use", ...call })),
});

function setup(steps: MockStep[], overrides: Partial<AgentRun> = {}) {
  const calls: Record<string, unknown>[] = [];
  const lookup: AgentTool = {
    definition: { name: "list_invoices", description: "Lists invoices.", inputSchema: {} },
    writes: false,
    call: async (input) => {
      calls.push(input);
      return { content: '{"invoices":[]}', isError: false };
    },
  };
  const refund: AgentTool = {
    definition: { name: "create_refund", description: "Refunds.", inputSchema: {} },
    writes: true,
    call: async (input) => {
      calls.push(input);
      return {
        content: JSON.stringify({ refund: { amountCents: input.amountCents } }),
        isError: false,
      };
    },
  };
  const provider = new MockProvider(steps);
  const run: AgentRun = {
    model: "mock-model",
    gateway: provider,
    context: { tenantId: "ten_a", ticketId: "tkt_1" },
    system: "system",
    ticket: "ticket text",
    tools: [lookup, refund],
    authorize: () => ({ decision: "allow" }),
    requestApproval: async () => "approved",
    ...overrides,
  };
  return { run, provider, calls };
}

const toolResults = (messages: Message[]) =>
  messages.flatMap((message) =>
    message.role === "user" ? message.content.filter((block) => block.type === "tool_result") : [],
  );

describe("runAgent", () => {
  it("runs tools, returns their results to the model, and ends on resolve_ticket", async () => {
    const { run, provider, calls } = setup([
      callTool("list_invoices", { invoiceNumber: "INV-1" }),
      resolve(),
    ]);

    const result = await runAgent(run);

    expect(result).toMatchObject({
      stopped: "resolved",
      turns: 2,
      resolution: { outcome: "refused", reasonCode: "outside_window", reply: "Sorry, no." },
    });
    expect(calls).toEqual([{ invoiceNumber: "INV-1" }]);
    const second = provider.calls[1]?.request.messages;
    expect(second?.[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", toolUseId: "call-list_invoices", content: '{"invoices":[]}' },
      ],
    });
    expect(provider.calls[0]?.request.tools?.map((tool) => tool.name)).toEqual([
      "list_invoices",
      "create_refund",
      "resolve_ticket",
    ]);
  });

  it("tells the model when it calls a tool that does not exist", async () => {
    const { run } = setup([callTool("delete_customer"), resolve()]);
    const result = await runAgent(run);

    expect(toolResults(result.messages)[0]).toMatchObject({
      isError: true,
      content: 'Unknown tool "delete_customer".',
    });
    expect(result.toolCalls).toEqual([]);
  });

  it("does not run a call that policy denies", async () => {
    const { run, calls } = setup([callTool("create_refund", { amountCents: 500 }), resolve()], {
      authorize: (call): Verdict =>
        call.tool === "create_refund"
          ? { decision: "deny", reason: "refunds are off" }
          : { decision: "allow" },
    });

    const result = await runAgent(run);

    expect(calls).toEqual([]);
    expect(result.toolCalls).toMatchObject([{ tool: "create_refund", verdict: "deny" }]);
    expect(toolResults(result.messages)[0]).toMatchObject({
      isError: true,
      content: "Not allowed by policy: refunds are off",
    });
  });

  it("waits for approval and runs the call only when it is given", async () => {
    const steps = () => [callTool("create_refund", { amountCents: 90_000 }), resolve()];
    const authorize = (): Verdict => ({ decision: "needs_approval", reason: "over the limit" });
    const asked: string[] = [];

    const approved = setup(steps(), {
      authorize,
      requestApproval: async (call, reason) => {
        asked.push(`${call.tool}: ${reason}`);
        return "approved";
      },
    });
    const rejected = setup(steps(), { authorize, requestApproval: async () => "rejected" });

    const yes = await runAgent(approved.run);
    const no = await runAgent(rejected.run);

    expect(asked).toEqual(["create_refund: over the limit"]);
    expect(approved.calls).toEqual([{ amountCents: 90_000 }]);
    expect(yes.toolCalls).toMatchObject([{ verdict: "approved" }]);
    expect(rejected.calls).toEqual([]);
    expect(no.toolCalls).toMatchObject([{ verdict: "rejected", outcome: { isError: true } }]);
  });

  it("does not run a call a person rejected, even when policy would now allow it", async () => {
    // The durable workflow asks policy again after the wait for a person.
    // The rules may have been relaxed in the meantime. The answer stands.
    const state = initialState("ticket");
    state.pending = [{ type: "tool_use", id: "call_1", name: "create_refund", input: {} }];
    let ran = 0;

    await settleNext(
      state,
      { kind: "tool", tool: "create_refund", input: {}, verdict: { decision: "allow" } },
      async () => {
        ran += 1;
        return { content: "{}", isError: false };
      },
      "rejected",
    );

    expect(ran).toBe(0);
    expect(state.toolCalls).toMatchObject([{ verdict: "rejected", outcome: { isError: true } }]);
  });

  it("gives the policy the calls made so far", async () => {
    const seen: number[] = [];
    const { run } = setup(
      [
        callTool("list_invoices"),
        callTool("create_refund", { amountCents: 1 }),
        resolve("refunded", "within_window", "0.01"),
      ],
      {
        authorize: (_call, history: ToolCallRecord[]) => {
          seen.push(history.length);
          return { decision: "allow" };
        },
      },
    );
    await runAgent(run);
    expect(seen).toEqual([0, 1]);
  });

  it("rejects resolve_ticket when it comes together with another call", async () => {
    const { run, calls } = setup([
      many(
        { id: "a", name: "create_refund", input: { amountCents: 100 } },
        {
          id: "b",
          name: "resolve_ticket",
          input: { outcome: "refunded", reasonCode: "within_window", reply: "1.00" },
        },
      ),
      resolve("refunded", "within_window", "Refunded $1.00."),
    ]);

    const result = await runAgent(run);

    expect(calls).toHaveLength(1);
    expect(toolResults(result.messages)[1]).toMatchObject({ toolUseId: "b", isError: true });
    expect(result).toMatchObject({ stopped: "resolved", turns: 2 });
  });

  it("asks again when the resolution is malformed", async () => {
    const { run } = setup([
      toolUseResponse({
        id: "bad",
        name: "resolve_ticket",
        input: { outcome: "paid_out", reasonCode: "x", reply: "" },
      }),
      resolve(),
    ]);
    const result = await runAgent(run);

    expect(toolResults(result.messages)[0]).toMatchObject({ toolUseId: "bad", isError: true });
    expect(result.stopped).toBe("resolved");
  });

  it("reminds the model once when it stops without resolving, then gives up", async () => {
    const reminded = setup([textResponse("I think we should refund."), resolve()]);
    const stubborn = setup([textResponse("Done."), textResponse("Really done.")]);

    expect(await runAgent(reminded.run)).toMatchObject({ stopped: "resolved", turns: 2 });
    expect(await runAgent(stubborn.run)).toMatchObject({ stopped: "no_resolution", turns: 2 });
    expect(reminded.provider.calls[1]?.request.messages.at(-1)).toMatchObject({ role: "user" });
  });

  it("stops at the turn limit", async () => {
    const { run, provider } = setup(
      Array.from({ length: 5 }, (_, i) => callTool("list_invoices", {}, `call-${i}`)),
      { maxTurns: 3 },
    );
    const result = await runAgent(run);

    expect(result).toMatchObject({ stopped: "turn_limit", turns: 3 });
    expect(provider.calls).toHaveLength(3);
  });

  it.each(["refusal", "max_tokens"] as const)(
    "never runs tool calls from a %s response",
    async (stopReason) => {
      const { run, calls } = setup([
        { ...callTool("create_refund", { amountCents: 100 }), stopReason },
      ]);
      const result = await runAgent(run);

      expect(result.stopped).toBe(stopReason);
      expect(calls).toEqual([]);
    },
  );

  it("stops cleanly when the budget runs out", async () => {
    const { run } = setup([callTool("list_invoices"), new BudgetExceededError("ticket", 10, 10)]);
    const result = await runAgent(run);

    expect(result).toMatchObject({ stopped: "budget", turns: 1 });
    expect(result.toolCalls).toHaveLength(1);
  });

  it("sends provider-specific blocks back unchanged", async () => {
    const thinking = { type: "opaque" as const, provider: "mock", data: { signature: "s" } };
    const first = callTool("list_invoices");
    const { run, provider } = setup([
      { ...first, content: [thinking, ...first.content] },
      resolve(),
    ]);

    await runAgent(run);

    expect(provider.calls[1]?.request.messages[1]?.content[0]).toEqual(thinking);
  });

  it("offers every tool as strict", async () => {
    const { run, provider } = setup([resolve()]);
    await runAgent(run);

    const tools = provider.calls[0]?.request.tools ?? [];
    expect(tools.map((tool) => tool.name)).toEqual([
      "list_invoices",
      "create_refund",
      "resolve_ticket",
    ]);
    expect(tools.every((tool) => tool.strict === true)).toBe(true);
  });
});

describe("resumeWith", () => {
  const finished = (): AgentState => ({
    messages: [
      { role: "user", content: [{ type: "text", text: "the ticket" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "res", name: "resolve_ticket", input: {} }],
      },
      { role: "user", content: [{ type: "tool_result", toolUseId: "res", content: "Recorded." }] },
    ],
    toolCalls: [],
    turns: 1,
    nudged: true,
    pending: [],
    batch: false,
    results: [],
    resolution: { outcome: "needs_clarification", reasonCode: "invoice_unclear", reply: "Which?" },
    stopped: "resolved",
  });

  it("adds the customer's words to the last user turn and lets the agent take another", () => {
    const state = finished();
    expect(resumeWith(state, { id: "msg_1", text: "the second one" })).toBe(true);

    // Turns still alternate: the answer joins the turn that reported the last result.
    expect(state.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(state.messages[2]?.content).toEqual([
      { type: "tool_result", toolUseId: "res", content: "Recorded." },
      { type: "text", text: "the second one" },
    ]);
    expect(state).toMatchObject({ nudged: false, turns: 1, followUps: ["msg_1"] });
    expect(state.stopped).toBeUndefined();
    expect(state.resolution).toBeUndefined();
  });

  it("takes each message in once", () => {
    const state = finished();
    resumeWith(state, { id: "msg_1", text: "the second one" });
    const after = structuredClone(state);

    expect(resumeWith(state, { id: "msg_1", text: "the second one" })).toBe(false);
    expect(state).toEqual(after);
    expect(resumeWith(state, { id: "msg_2", text: "and thanks" })).toBe(true);
    expect(state.followUps).toEqual(["msg_1", "msg_2"]);
  });
});

describe("withSystemIdempotency", () => {
  const inner = (seen: Record<string, unknown>[]): AgentTool => ({
    definition: {
      name: "create_refund",
      description:
        "Refunds money. Repeating a call with the same idempotencyKey returns the first refund instead of paying again.",
      inputSchema: {
        type: "object",
        properties: { paymentId: {}, amountCents: {}, idempotencyKey: {} },
        required: ["paymentId", "amountCents", "idempotencyKey"],
      },
    },
    writes: true,
    call: async (input) => {
      seen.push(input);
      return { content: "{}", isError: false };
    },
  });

  it("hides the key from the model", () => {
    const tool = withSystemIdempotency(inner([]), "tkt_1");
    expect(tool.definition.inputSchema).toMatchObject({ required: ["paymentId", "amountCents"] });
    expect(tool.definition.inputSchema.properties).not.toHaveProperty("idempotencyKey");
    expect(tool.definition.description).toBe("Refunds money.");
  });

  it("derives the same key for the same call and ignores a key the model invents", async () => {
    const seen: Record<string, unknown>[] = [];
    const tool = withSystemIdempotency(inner(seen), "tkt_1");

    await tool.call({ paymentId: "pay_1", amountCents: 500 });
    await tool.call({ amountCents: 500, paymentId: "pay_1", idempotencyKey: "model-made-this-up" });
    await tool.call({ paymentId: "pay_1", amountCents: 501 });

    expect(seen[0]?.idempotencyKey).toBe(seen[1]?.idempotencyKey);
    expect(seen[0]?.idempotencyKey).not.toBe(seen[2]?.idempotencyKey);
    expect(String(seen[0]?.idempotencyKey).startsWith("tkt_1:create_refund:")).toBe(true);
  });
});

describe("ungroundedAmounts", () => {
  const invoices: ToolCallRecord = {
    tool: "list_invoices",
    input: {},
    verdict: "allow",
    outcome: {
      isError: false,
      content: JSON.stringify({
        invoices: [{ amountCents: 87_00, payments: [{ amountCents: 1_234_50 }] }],
      }),
    },
  };
  const given = {
    texts: ["Refunds above $200 need approval.", "I was charged 58 dollars, or $58."],
    toolCalls: [invoices],
  };

  it("accepts amounts from the instructions, the ticket and tool results", () => {
    expect(
      ungroundedAmounts(
        "Your $87.00 charge and the $1,234.50 payment are under the $200 limit. You wrote $58.",
        given,
      ),
    ).toEqual([]);
  });

  it("accepts an amount written out inside a tool result's text", () => {
    const passage: ToolCallRecord = {
      tool: "search_help_center",
      input: {},
      verdict: "allow",
      outcome: {
        isError: false,
        content: JSON.stringify({ passages: [{ text: "Business costs $50 per seat." }] }),
      },
    };
    expect(
      ungroundedAmounts("Business is $50 per seat.", { texts: [], toolCalls: [passage] }),
    ).toEqual([]);
  });

  it("reports an amount that appears nowhere", () => {
    expect(ungroundedAmounts("I have credited $95.00 and will add €10 next month.", given)).toEqual(
      ["95.00", "10.00"],
    );
  });

  it("ignores numbers that are not money", () => {
    expect(
      ungroundedAmounts("It takes 5 to 10 business days, by 14 November 2026.", given),
    ).toEqual([]);
  });
});

describe("checkResolution", () => {
  const refunded = (amountCents: number, id = `ref_${amountCents}`): ToolCallRecord => ({
    tool: "create_refund",
    input: {},
    verdict: "allow",
    outcome: { content: JSON.stringify({ refund: { id, amountCents } }), isError: false },
  });
  const failed: ToolCallRecord = {
    tool: "create_refund",
    input: {},
    verdict: "allow",
    outcome: { content: '{"error":{"code":"payment_not_found"}}', isError: true },
  };
  const said = (outcome: "refunded" | "refused", reply: string) =>
    ({ outcome, reasonCode: "within_window", reply }) as const;

  it("passes when the reply matches what was done", () => {
    expect(
      checkResolution(said("refunded", "I refunded $87.00 for INV-1."), [refunded(87_00)]),
    ).toEqual([]);
    expect(
      checkResolution(said("refunded", "Refunded $1,234.50."), [
        refunded(1_000_00),
        refunded(234_50),
      ]),
    ).toEqual([]);
    expect(checkResolution(said("refused", "That is outside the window."), [failed])).toEqual([]);
  });

  it("counts a refund once when a repeated call returned the same refund", () => {
    const twice = [refunded(87_00, "ref_same"), refunded(87_00, "ref_same")];
    expect(checkResolution(said("refunded", "I refunded $87.00."), twice)).toEqual([]);
  });

  it("catches a claimed refund that was never made", () => {
    expect(checkResolution(said("refunded", "I refunded $87.00."), [failed])).toEqual([
      "claims_refund_not_made",
    ]);
  });

  it("catches a refund that the resolution does not report", () => {
    expect(checkResolution(said("refused", "We cannot refund this."), [refunded(87_00)])).toEqual([
      "refund_made_not_reported",
      "reply_omits_refunded_amount",
    ]);
  });

  it("catches a reply that states the wrong amount", () => {
    expect(checkResolution(said("refunded", "I refunded $78.00."), [refunded(87_00)])).toEqual([
      "reply_omits_refunded_amount",
    ]);
  });
});
