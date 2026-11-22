import { fileURLToPath } from "node:url";
import type { Message, ModelRequest, ToolUseBlock } from "@proofdesk/gateway";
import { afterEach, describe, expect, it } from "vitest";
import { type ClaudeCodeProvider, createClaudeCodeProvider } from "./claude-code-provider.ts";

const fake = fileURLToPath(new URL("./testing/fake-claude-code.ts", import.meta.url));
const context = { tenantId: "ten_a", ticketId: "tkt_1" };

let provider: ClaudeCodeProvider | undefined;
afterEach(async () => {
  await provider?.close();
  provider = undefined;
});

async function start() {
  provider = await createClaudeCodeProvider({
    launch: { command: process.execPath, args: [fake] },
  });
  const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "first" }] }];
  const request: ModelRequest = {
    model: "claude-haiku-5-5",
    system: "You test.",
    messages,
    maxTokens: 100,
    tools: [
      {
        name: "lookup",
        description: "Looks something up.",
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
      },
    ],
  };
  return { provider, request, messages };
}

describe("the model through the Claude Code command line", () => {
  it("hands back a tool call under the tool's own name, with its input put together", async () => {
    const { provider, request } = await start();
    const response = await provider.complete(request, context);

    expect(response.stopReason).toBe("tool_use");
    expect(response.model).toBe("claude-haiku-5-5");
    expect(response.content).toEqual([
      { type: "text", text: "Looking." },
      { type: "tool_use", id: "toolu_fake_1", name: "lookup", input: { q: "first" } },
    ]);
  });

  it("holds the tool call until the caller answers it, then gives the model the answer", async () => {
    const { provider, request, messages } = await start();
    const first = await provider.complete(request, context);
    const call = first.content.find((block): block is ToolUseBlock => block.type === "tool_use");
    messages.push({ role: "assistant", content: first.content });
    // The caller's loop decides the call. Here it refuses it, as policy might.
    messages.push({
      role: "user",
      content: [
        { type: "tool_result", toolUseId: call?.id ?? "", content: "denied", isError: true },
      ],
    });

    const second = await provider.complete(request, context);
    expect(second.stopReason).toBe("end_turn");
    expect(second.content).toEqual([{ type: "text", text: "seen denied (error)" }]);
  });

  it("carries the same conversation on when the customer answers", async () => {
    const { provider, request, messages } = await start();
    const first = await provider.complete(request, context);
    messages.push({ role: "assistant", content: first.content });
    messages.push({
      role: "user",
      content: [{ type: "tool_result", toolUseId: "toolu_fake_1", content: "R1" }],
    });
    const done = await provider.complete(request, context);
    messages.push({ role: "assistant", content: done.content });
    messages.push({ role: "user", content: [{ type: "text", text: "second" }] });

    const again = await provider.complete(request, context);
    expect(again.content.at(-1)).toEqual({
      type: "tool_use",
      id: "toolu_fake_2",
      name: "lookup",
      input: { q: "second" },
    });
  });

  it("refuses to pick up a conversation it did not start", async () => {
    const { provider, request } = await start();
    const elsewhere: Message[] = [
      { role: "user", content: [{ type: "text", text: "first" }] },
      { role: "assistant", content: [{ type: "text", text: "from another provider" }] },
      { role: "user", content: [{ type: "text", text: "go on" }] },
    ];
    await expect(
      provider.complete({ ...request, messages: elsewhere }, context),
    ).rejects.toMatchObject({
      kind: "invalid_request",
    });
  });

  it("reports a command line that stops as unavailable, so the ticket goes to staff", async () => {
    const { provider, request, messages } = await start();
    messages[0] = { role: "user", content: [{ type: "text", text: "exit" }] };
    await expect(provider.complete(request, context)).rejects.toMatchObject({
      name: "ProviderError",
      kind: "unavailable",
    });
  });

  it("starts afresh when a first turn that failed is tried again", async () => {
    // The gateway retries a call that failed for a reason that may pass. The
    // retry carries the same list of messages, and must not be taken for a
    // conversation that is already under way.
    const { provider, request, messages } = await start();
    messages[0] = { role: "user", content: [{ type: "text", text: "exit" }] };
    await expect(provider.complete(request, context)).rejects.toMatchObject({
      kind: "unavailable",
    });

    messages[0] = { role: "user", content: [{ type: "text", text: "first" }] };
    const retried = await provider.complete(request, context);
    expect(retried.content.at(-1)).toMatchObject({ type: "tool_use", input: { q: "first" } });
  });
});
