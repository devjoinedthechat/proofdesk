import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// A stand-in for the Claude Code command line, for testing the provider that
// drives it. It speaks the same stream format and really calls the MCP server
// it is given, so a test sees what the provider does with a held tool call.
//
// For every message the customer sends it calls the tool `lookup` with that
// text, then answers with the tool's result. A message of "exit" makes it
// stop without a result, as the real one does when it fails.

const argv = process.argv.slice(2);
const config = JSON.parse(argv[argv.indexOf("--mcp-config") + 1] ?? "{}") as {
  mcpServers: Record<string, { url: string }>;
};
const [server] = Object.entries(config.mcpServers);
if (!server) throw new Error("No MCP server was configured");
const [name, { url }] = server;
const model = argv[argv.indexOf("--model") + 1] ?? "fake";

const client = new Client({ name: "fake-claude-code", version: "0.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));
const { tools } = await client.listTools();

const emit = (event: unknown) =>
  process.stdout.write(`${JSON.stringify({ type: "stream_event", event })}\n`);
const usage = { input_tokens: 3, output_tokens: 0 };
let sequence = 0;

async function answer(text: string) {
  const id = `toolu_fake_${++sequence}`;
  const input = JSON.stringify({ q: text });
  emit({ type: "message_start", message: { model, usage } });
  emit({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  emit({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Looking." } });
  emit({
    type: "content_block_start",
    index: 1,
    content_block: { type: "tool_use", id, name: `mcp__${name}__lookup` },
  });
  emit({
    type: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: input.slice(0, 4) },
  });
  emit({
    type: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: input.slice(4) },
  });
  emit({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } });
  emit({ type: "message_stop" });

  const result = await client.callTool({ name: "lookup", arguments: { q: text } });
  const shown = (result.content as { text?: string }[]).map((block) => block.text).join("");

  emit({ type: "message_start", message: { model, usage } });
  emit({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  emit({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: `seen ${shown}${result.isError ? " (error)" : ""}` },
  });
  emit({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } });
  emit({ type: "message_stop" });
  process.stdout.write(`${JSON.stringify({ type: "result", is_error: false })}\n`);
}

if (!tools.some((tool) => tool.name === "lookup")) throw new Error("No lookup tool was offered");
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line) as { message: { content: { text: string }[] } };
  const text = message.message.content.map((block) => block.text).join("");
  if (text === "exit") process.exit(3);
  await answer(text);
}
