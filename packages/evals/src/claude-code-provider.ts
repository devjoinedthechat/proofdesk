import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  type AssistantBlock,
  type CallContext,
  type Message,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  ProviderError,
  type StopReason,
  type ToolDefinition,
  type ToolResultBlock,
  type Usage,
} from "@proofdesk/gateway";
import { type Served, serve } from "@proofdesk/service";

// The model, reached through the Claude Code command line instead of the API.
// It exists so the evals can run on a Claude subscription when there is no
// API key. The command line signs in by itself; nothing here holds a
// credential.
//
// The command line keeps the conversation and runs its own loop, so it is
// held at each tool call: the agent's tools are offered to it by a local MCP
// server whose calls do not return until this repository's own loop has
// checked the call against policy, run it or refused it, and produced the
// result. The loop under test is therefore still this repository's, and the
// command line is only the way to the model.
//
// What differs from the API, and is said wherever these results are shown:
//
// - The model sees each tool under a prefixed name, `mcp__desk__<name>`.
// - Tools are not strict: arguments are checked after the model wrote them,
//   not constrained while it writes.
// - The command line may add text of its own around the system prompt.
// - Token counts are the command line's, and costs are list-price estimates.

const NAME = "claude-code";
const SERVER = "desk";
const PREFIX = `mcp__${SERVER}__`;
/** A conversation nobody has continued for this long is closed. */
const IDLE_MS = 15_000;
/** How long the model gets for one turn. */
const TURN_MS = 180_000;

type Turn =
  | {
      kind: "message";
      content: AssistantBlock[];
      stopReason: StopReason;
      usage: Usage;
      model: string;
    }
  | { kind: "result"; error?: string }
  | { kind: "exit"; detail: string };

type ToolCall = { name: string; key: string; answer(result: ToolResultBlock): void };

/** A value's JSON with object keys in order, so two spellings of one input compare equal. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${stable(inner)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** A queue a reader can wait on. */
class Inbox<Item> {
  readonly #items: Item[] = [];
  #wake: (() => void) | undefined;

  push(item: Item) {
    this.#items.push(item);
    this.#wake?.();
  }

  /** The first item that matches, removed from the queue; waits for one if none is there. */
  async take(matches: (item: Item) => boolean, timeoutMs: number, what: string): Promise<Item> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const at = this.#items.findIndex(matches);
      if (at >= 0) return this.#items.splice(at, 1)[0] as Item;
      const left = deadline - Date.now();
      if (left <= 0) throw new ProviderError(NAME, "timeout", `Timed out waiting for ${what}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.#wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.#wake = undefined;
    }
  }
}

class Conversation {
  readonly token = randomBytes(12).toString("hex");
  readonly tools: ToolDefinition[];
  readonly turns = new Inbox<Turn>();
  readonly calls = new Inbox<ToolCall>();
  /** Tool calls handed to the caller and not yet answered, by the id the caller knows. */
  readonly open = new Map<string, { name: string; key: string }>();
  /** User blocks of the request that have been dealt with. */
  consumed = 0;
  /** What the customer said that the model has not been shown yet. */
  unsent: string[] = [];
  /** True once the command line has finished its turn and reads input again. */
  idle = true;
  #proc: ChildProcessWithoutNullStreams | undefined;
  #timer: NodeJS.Timeout | undefined;
  readonly #directory = mkdtempSync(join(tmpdir(), "proofdesk-claude-code-"));

  constructor(tools: ToolDefinition[]) {
    this.tools = tools;
  }

  start(binary: string, request: ModelRequest, mcpUrl: string) {
    const config = { mcpServers: { [SERVER]: { type: "http", url: `${mcpUrl}/${this.token}` } } };
    const { ANTHROPIC_API_KEY: _key, ...env } = process.env;
    const proc = spawn(
      binary,
      [
        "--print",
        "--verbose",
        "--input-format=stream-json",
        "--output-format=stream-json",
        "--include-partial-messages",
        "--no-session-persistence",
        "--model",
        request.model,
        "--system-prompt",
        request.system ?? "",
        // None of the command line's own tools, settings or servers.
        "--tools",
        "",
        "--setting-sources",
        "",
        "--strict-mcp-config",
        "--mcp-config",
        JSON.stringify(config),
        "--allowedTools",
        ...this.tools.map((tool) => PREFIX + tool.name),
        ...(request.effort ? ["--effort", request.effort] : []),
      ],
      // An empty directory, so there is no project for it to read.
      { cwd: this.#directory, env },
    );
    this.#proc = proc;
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    proc.on("error", (error) => this.turns.push({ kind: "exit", detail: error.message }));
    proc.on("close", (code) =>
      this.turns.push({ kind: "exit", detail: `exit code ${code}. ${stderr.trim()}` }),
    );

    // One model message at a time, put together from the stream.
    let blocks: (AssistantBlock & { json?: string })[] = [];
    let model = request.model;
    let usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let stop: string | undefined;
    createInterface({ input: proc.stdout }).on("line", (line) => {
      // biome-ignore lint/suspicious/noExplicitAny: the command line's stream is loosely shaped JSON
      let parsed: Record<string, any>;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }
      if (parsed.type === "result") {
        this.turns.push({
          kind: "result",
          ...(parsed.is_error ? { error: String(parsed.result ?? parsed.subtype ?? "error") } : {}),
        });
        return;
      }
      if (parsed.type !== "stream_event") return;
      // biome-ignore lint/suspicious/noExplicitAny: the command line's stream is loosely shaped JSON
      const event = parsed.event as Record<string, any>;
      if (event.type === "message_start") {
        blocks = [];
        stop = undefined;
        model = event.message?.model ?? model;
        const used = event.message?.usage ?? {};
        usage = {
          inputTokens: used.input_tokens ?? 0,
          outputTokens: used.output_tokens ?? 0,
          cacheReadTokens: used.cache_read_input_tokens ?? 0,
          cacheWriteTokens: used.cache_creation_input_tokens ?? 0,
        };
      } else if (event.type === "content_block_start") {
        const block = event.content_block ?? {};
        if (block.type === "text") blocks[event.index] = { type: "text", text: block.text ?? "" };
        if (block.type === "tool_use") {
          blocks[event.index] = {
            type: "tool_use",
            id: block.id,
            name: String(block.name).startsWith(PREFIX)
              ? String(block.name).slice(PREFIX.length)
              : String(block.name),
            input: {},
            json: "",
          };
        }
      } else if (event.type === "content_block_delta") {
        const block = blocks[event.index];
        if (block?.type === "text" && event.delta?.type === "text_delta") {
          block.text += event.delta.text;
        }
        if (block?.type === "tool_use" && event.delta?.type === "input_json_delta") {
          block.json += event.delta.partial_json;
        }
      } else if (event.type === "message_delta") {
        stop = event.delta?.stop_reason ?? stop;
        if (event.usage?.output_tokens !== undefined) {
          usage = { ...usage, outputTokens: event.usage.output_tokens };
        }
      } else if (event.type === "message_stop") {
        const content: AssistantBlock[] = [];
        // Blocks this repository has no use for, such as thinking, leave gaps.
        for (const block of blocks.filter(Boolean)) {
          if (block.type !== "tool_use") {
            content.push(block);
            continue;
          }
          let input: unknown = {};
          try {
            input = block.json ? JSON.parse(block.json) : {};
          } catch {
            // Left as it is: the loop refuses an input that is not an object.
            input = block.json;
          }
          content.push({ type: "tool_use", id: block.id, name: block.name, input });
        }
        const stopReason: StopReason =
          stop === "tool_use" || stop === "max_tokens" || stop === "refusal" ? stop : "end_turn";
        this.turns.push({ kind: "message", content, stopReason, usage, model });
      }
    });
  }

  say(text: string) {
    this.idle = false;
    this.#proc?.stdin.write(
      `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })}\n`,
    );
  }

  /** Called on every use. A conversation left alone is closed, with its process. */
  touch(onIdle: () => void) {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(onIdle, IDLE_MS);
    this.#timer.unref();
  }

  close() {
    clearTimeout(this.#timer);
    this.#proc?.kill("SIGKILL");
    this.#proc = undefined;
    rmSync(this.#directory, { recursive: true, force: true });
  }
}

export type ClaudeCodeProvider = ModelProvider & { close(): Promise<void> };

/**
 * A model provider that asks the Claude Code command line. `binary` is its
 * path, or its name when it is on the PATH.
 */
export async function createClaudeCodeProvider(
  options: { binary?: string } = {},
): Promise<ClaudeCodeProvider> {
  const binary = options.binary ?? process.env.CLAUDE_CODE_BIN ?? "claude";
  /** The conversation a request belongs to, found by the list of messages it carries. */
  const byMessages = new WeakMap<Message[], Conversation>();
  const byToken = new Map<string, Conversation>();

  // The agent's tools, as the command line sees them. A call is held open
  // until the caller's loop has an answer for it.
  const served: Served = await serve(
    {
      async fetch(request) {
        const conversation = byToken.get(new URL(request.url).pathname.split("/").at(-1) ?? "");
        if (!conversation) return new Response("Not found", { status: 404 });
        if (request.method !== "POST") return new Response("Use POST", { status: 405 });
        const server = new Server(
          { name: SERVER, version: "0.1.0" },
          { capabilities: { tools: {} } },
        );
        server.setRequestHandler(ListToolsRequestSchema, async () => ({
          tools: conversation.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema as { type: "object" },
          })),
        }));
        server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
          const result = await new Promise<ToolResultBlock>((answer) => {
            conversation.calls.push({
              name: params.name,
              key: stable(params.arguments ?? {}),
              answer,
            });
          });
          return {
            content: [{ type: "text", text: result.content }],
            ...(result.isError ? { isError: true } : {}),
          };
        });
        const transport = new WebStandardStreamableHTTPServerTransport({
          enableJsonResponse: true,
        });
        await server.connect(transport);
        return transport.handleRequest(request);
      },
    },
    { port: 0, hostname: "127.0.0.1" },
  );

  function end(conversation: Conversation) {
    byToken.delete(conversation.token);
    conversation.close();
  }

  async function nextMessage(conversation: Conversation) {
    const turn = await conversation.turns.take(
      (candidate) => candidate.kind !== "result" || candidate.error !== undefined,
      TURN_MS,
      "the model",
    );
    if (turn.kind === "message") return turn;
    end(conversation);
    const detail = turn.kind === "exit" ? turn.detail : (turn.error ?? "");
    const limited = /limit|quota|overloaded|rate/i.test(detail);
    throw new ProviderError(
      NAME,
      limited ? "rate_limited" : "unavailable",
      `The Claude Code command line stopped: ${detail.slice(0, 300)}`,
    );
  }

  return {
    name: NAME,

    async complete(request: ModelRequest, context: CallContext): Promise<ModelResponse> {
      context.signal?.throwIfAborted();
      let conversation = byMessages.get(request.messages);
      if (!conversation) {
        if (request.messages.length !== 1) {
          throw new ProviderError(
            NAME,
            "invalid_request",
            "A conversation can only be carried on by the provider that started it",
          );
        }
        conversation = new Conversation(request.tools ?? []);
        byMessages.set(request.messages, conversation);
        byToken.set(conversation.token, conversation);
        conversation.start(binary, request, `${served.url}/mcp`);
      }
      const current = conversation;
      current.touch(() => end(current));

      // What the caller added since the last turn: results for the tool
      // calls it was handed, and anything new the customer said.
      const blocks = request.messages.flatMap((message) =>
        message.role === "user" ? message.content : [],
      );
      const added = blocks.slice(current.consumed);
      current.consumed = blocks.length;
      let answered = 0;
      for (const block of added) {
        if (block.type === "text") {
          current.unsent.push(block.text);
          continue;
        }
        const asked = current.open.get(block.toolUseId);
        if (!asked) continue;
        current.open.delete(block.toolUseId);
        const call = await current.calls.take(
          (candidate) => candidate.name === asked.name && candidate.key === asked.key,
          TURN_MS,
          `the command line to call ${asked.name}`,
        );
        call.answer(block);
        answered += 1;
      }

      let message = answered > 0 ? await nextMessage(current) : undefined;
      // The customer's words go in once the model has finished what it was
      // saying. If it asked for another tool instead, they wait their turn.
      while (current.unsent.length > 0 && message?.stopReason !== "tool_use") {
        if (!current.idle) {
          const ended = await current.turns.take(
            (turn) => turn.kind !== "message",
            TURN_MS,
            "the turn to end",
          );
          if (ended.kind === "exit") {
            end(current);
            throw new ProviderError(
              NAME,
              "unavailable",
              `The command line stopped: ${ended.detail}`,
            );
          }
          current.idle = true;
        }
        current.say(current.unsent.splice(0).join("\n\n"));
        message = await nextMessage(current);
      }
      if (!message) {
        throw new ProviderError(NAME, "invalid_request", "The request adds nothing to answer");
      }

      for (const block of message.content) {
        if (block.type === "tool_use") {
          current.open.set(block.id, { name: block.name, key: stable(block.input) });
        }
      }
      current.touch(() => end(current));
      return {
        model: message.model,
        content: message.content,
        stopReason: message.stopReason,
        usage: message.usage,
      };
    },

    async close() {
      for (const conversation of [...byToken.values()]) end(conversation);
      await served.close();
    },
  };
}
