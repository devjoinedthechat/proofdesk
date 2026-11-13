import {
  BudgetExceededError,
  type CallContext,
  type Effort,
  type Message,
  type ModelProvider,
  type ToolUseBlock,
  type UserBlock,
} from "@proofdesk/gateway";
import { RESOLVE_TOOL, type Resolution, resolutionSchema, resolveTool } from "./resolution.ts";
import type {
  AgentTool,
  Authorize,
  RequestApproval,
  ToolCallRecord,
  ToolOutcome,
} from "./tools.ts";

export type AgentRun = {
  model: string;
  gateway: ModelProvider;
  /** Who the work is for. Budgets and traces are keyed on it. */
  context: CallContext;
  system: string;
  /** The first user message: the ticket, wrapped and dated. */
  ticket: string;
  tools: AgentTool[];
  authorize: Authorize;
  requestApproval: RequestApproval;
  maxTurns?: number;
  maxTokens?: number;
  effort?: Effort;
};

/** How a run ended. Only `resolved` carries a resolution. */
export type StopCause =
  | "resolved"
  | "turn_limit"
  | "budget"
  | "refusal"
  | "max_tokens"
  | "no_resolution";

export type AgentResult = {
  stopped: StopCause;
  resolution?: Resolution;
  turns: number;
  toolCalls: ToolCallRecord[];
  messages: Message[];
};

const error = (content: string): ToolOutcome => ({ content, isError: true });

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The agent loop: ask the model, run the tools it asks for, give it the
 * results, repeat. Every control sits in plain sight between a model response
 * and a tool call: the tool must exist, policy must allow the call, a person
 * approves when policy says so, and the run is bounded in turns and money.
 */
export async function runAgent(run: AgentRun): Promise<AgentResult> {
  const maxTurns = run.maxTurns ?? 12;
  const tools = new Map(run.tools.map((tool) => [tool.definition.name, tool]));
  const definitions = [...run.tools.map((tool) => tool.definition), resolveTool];

  const messages: Message[] = [{ role: "user", content: [{ type: "text", text: run.ticket }] }];
  const toolCalls: ToolCallRecord[] = [];
  let nudged = false;

  const finish = (stopped: StopCause, turns: number, resolution?: Resolution): AgentResult => ({
    stopped,
    turns,
    toolCalls,
    messages,
    ...(resolution ? { resolution } : {}),
  });

  async function execute(block: ToolUseBlock): Promise<ToolOutcome> {
    const tool = tools.get(block.name);
    if (!tool) return error(`Unknown tool "${block.name}".`);
    if (!isObject(block.input)) return error("The tool input must be a JSON object.");
    const call = { tool: block.name, input: block.input };

    const verdict = await run.authorize(call, toolCalls);
    if (verdict.decision === "deny") {
      const outcome = error(`Not allowed by policy: ${verdict.reason}`);
      toolCalls.push({ ...call, verdict: "deny", outcome });
      return outcome;
    }
    if (verdict.decision === "needs_approval") {
      const answer = await run.requestApproval(call, verdict.reason);
      if (answer === "rejected") {
        const outcome = error("approval_rejected: staff reviewed this action and declined it.");
        toolCalls.push({ ...call, verdict: "rejected", outcome });
        return outcome;
      }
    }

    const outcome = await tool.call(block.input);
    toolCalls.push({
      ...call,
      verdict: verdict.decision === "needs_approval" ? "approved" : "allow",
      outcome,
    });
    return outcome;
  }

  for (let turn = 1; turn <= maxTurns; turn++) {
    let response: Awaited<ReturnType<ModelProvider["complete"]>>;
    try {
      response = await run.gateway.complete(
        {
          model: run.model,
          system: run.system,
          messages,
          tools: definitions,
          maxTokens: run.maxTokens ?? 8000,
          ...(run.effort ? { effort: run.effort } : {}),
        },
        run.context,
      );
    } catch (caught) {
      if (caught instanceof BudgetExceededError) return finish("budget", turn - 1);
      throw caught;
    }
    messages.push({ role: "assistant", content: response.content });

    // A refusal or a cut-off response is never acted on, even if it contains tool calls.
    if (response.stopReason === "refusal") return finish("refusal", turn);
    if (response.stopReason === "max_tokens") return finish("max_tokens", turn);

    const calls = response.content.filter((block) => block.type === "tool_use");
    if (calls.length === 0) {
      // The model stopped without resolving. Remind it once, then give up.
      if (nudged) return finish("no_resolution", turn);
      nudged = true;
      messages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: `Finish the ticket by calling ${RESOLVE_TOOL} with the outcome, the reason code and your reply to the customer.`,
          },
        ],
      });
      continue;
    }

    const results: UserBlock[] = [];
    let resolution: Resolution | undefined;
    for (const block of calls) {
      let outcome: ToolOutcome;
      if (block.name !== RESOLVE_TOOL) {
        outcome = await execute(block);
      } else if (calls.length > 1) {
        // Resolving in the same breath as another call means deciding before
        // seeing that call's result.
        outcome = error(
          `${RESOLVE_TOOL} must be called alone, after you have seen the results of your other tool calls.`,
        );
      } else {
        const parsed = resolutionSchema.safeParse(block.input);
        if (parsed.success) resolution = parsed.data;
        outcome = parsed.success
          ? { content: "Recorded.", isError: false }
          : error(`Invalid resolution: ${parsed.error.issues[0]?.message ?? "invalid"}`);
      }
      results.push({
        type: "tool_result",
        toolUseId: block.id,
        content: outcome.content,
        ...(outcome.isError ? { isError: true } : {}),
      });
    }
    messages.push({ role: "user", content: results });
    if (resolution) return finish("resolved", turn, resolution);
  }

  return finish("turn_limit", maxTurns);
}
