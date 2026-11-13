import {
  BudgetExceededError,
  type CallContext,
  type Effort,
  type Message,
  type ModelProvider,
  type ToolDefinition,
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
  Verdict,
} from "./tools.ts";

/** How a run ended. Only `resolved` carries a resolution. */
export type StopCause =
  | "resolved"
  | "turn_limit"
  | "budget"
  | "refusal"
  | "max_tokens"
  | "no_resolution"
  /** Set from outside the loop, when the model could not be reached at all. */
  | "model_unavailable"
  /** Set from outside the loop, when staff or a watchdog paused the agent. */
  | "paused";

/**
 * Everything about a run that must survive between steps. It is plain data,
 * so it can live in memory for an evaluation or in a database row between
 * the activities of a durable workflow.
 */
export type AgentState = {
  messages: Message[];
  toolCalls: ToolCallRecord[];
  turns: number;
  nudged: boolean;
  /** Tool calls from the latest model response that have not been answered yet. */
  pending: ToolUseBlock[];
  /** Whether the latest response contained more than one tool call. */
  batch: boolean;
  /** Results gathered for the latest response, sent back once all are in. */
  results: UserBlock[];
  resolution?: Resolution;
  stopped?: StopCause;
  /** The customer's later messages that have been added to the conversation, by id. */
  followUps?: string[];
};

/**
 * Carries a finished conversation on with something new the customer said.
 * Everything so far stays, the last resolution is set aside, and the agent
 * may take another turn. Each message is added once, however often this is
 * called with it.
 */
export function resumeWith(state: AgentState, message: { id: string; text: string }): boolean {
  if (state.followUps?.includes(message.id)) return false;
  const last = state.messages.at(-1);
  const block = { type: "text" as const, text: message.text };
  // A conversation alternates turns. The customer's words join the last user
  // turn when there is one, which is where the previous result was reported.
  if (last?.role === "user") last.content.push(block);
  else state.messages.push({ role: "user", content: [block] });
  state.followUps = [...(state.followUps ?? []), message.id];
  state.pending = [];
  state.results = [];
  state.nudged = false;
  delete state.resolution;
  delete state.stopped;
  return true;
}

export function initialState(ticket: string): AgentState {
  return {
    messages: [{ role: "user", content: [{ type: "text", text: ticket }] }],
    toolCalls: [],
    turns: 0,
    nudged: false,
    pending: [],
    batch: false,
    results: [],
  };
}

export type ModelStep = {
  model: string;
  gateway: ModelProvider;
  /** Who the work is for. Budgets and traces are keyed on it. */
  context: CallContext;
  system: string;
  /** The tools the model may call, without the resolution tool. */
  tools: ToolDefinition[];
  maxTurns?: number;
  maxTokens?: number;
  effort?: Effort;
};

const failure = (content: string): ToolOutcome => ({ content, isError: true });

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One model call. Afterwards the state either has tool calls pending, or the
 * run has stopped, or (after a reminder) it is ready for another model call.
 *
 * Returns the model that answered, which is not always the one asked for, or
 * nothing when no call was made.
 */
export async function modelStep(state: AgentState, step: ModelStep): Promise<string | undefined> {
  if (state.stopped || state.pending.length > 0) return undefined;
  if (state.turns >= (step.maxTurns ?? 12)) {
    state.stopped = "turn_limit";
    return undefined;
  }

  let response: Awaited<ReturnType<ModelProvider["complete"]>>;
  try {
    response = await step.gateway.complete(
      {
        model: step.model,
        system: step.system,
        messages: state.messages,
        // Every tool is strict: the model's arguments are constrained to the
        // tool's schema as they are generated, not only checked afterwards.
        tools: [...step.tools.map((tool) => ({ ...tool, strict: true })), resolveTool],
        maxTokens: step.maxTokens ?? 8000,
        ...(step.effort ? { effort: step.effort } : {}),
      },
      step.context,
    );
  } catch (caught) {
    if (!(caught instanceof BudgetExceededError)) throw caught;
    state.stopped = "budget";
    return undefined;
  }
  state.turns += 1;
  state.messages.push({ role: "assistant", content: response.content });

  // A refusal or a cut-off response is never acted on, even if it contains tool calls.
  if (response.stopReason === "refusal" || response.stopReason === "max_tokens") {
    state.stopped = response.stopReason;
    return response.model;
  }

  const calls = response.content.filter((block) => block.type === "tool_use");
  if (calls.length > 0) {
    state.pending = calls;
    state.batch = calls.length > 1;
    state.results = [];
    return response.model;
  }

  // The model stopped without resolving. Remind it once, then give up.
  if (state.nudged) {
    state.stopped = "no_resolution";
    return response.model;
  }
  state.nudged = true;
  state.messages.push({
    role: "user",
    content: [
      {
        type: "text",
        text: `Finish the ticket by calling ${RESOLVE_TOOL} with the outcome, the reason code and your reply to the customer.`,
      },
    ],
  });
  return response.model;
}

/** What the next pending tool call needs before it can be settled. */
export type NextCall =
  | { kind: "none" }
  /** Handled by the loop itself: the resolution tool, an unknown tool, or malformed input. */
  | { kind: "internal" }
  | { kind: "tool"; tool: string; input: Record<string, unknown>; verdict: Verdict };

/** Looks at the next pending call and asks the policy about it. Changes nothing. */
export async function inspectNext(
  state: AgentState,
  known: (tool: string) => boolean,
  authorize: Authorize,
): Promise<NextCall> {
  const [block] = state.pending;
  if (!block) return { kind: "none" };
  if (block.name === RESOLVE_TOOL || !known(block.name) || !isObject(block.input)) {
    return { kind: "internal" };
  }
  const call = { tool: block.name, input: block.input };
  return { kind: "tool", ...call, verdict: await authorize(call, state.toolCalls) };
}

/**
 * Settles the next pending call. `approval` is a person's answer when the
 * policy asked for one. A tool runs only when policy allowed it, or policy
 * asked for approval and a person gave it.
 */
export async function settleNext(
  state: AgentState,
  next: NextCall,
  run: (tool: string, input: Record<string, unknown>) => Promise<ToolOutcome>,
  approval?: "approved" | "rejected",
): Promise<void> {
  const block = state.pending[0];
  if (!block || next.kind === "none") return;

  let outcome: ToolOutcome;
  if (next.kind === "tool") {
    const { verdict } = next;
    const record = (label: ToolCallRecord["verdict"], result: ToolOutcome) => {
      state.toolCalls.push({ tool: next.tool, input: next.input, verdict: label, outcome: result });
      return result;
    };
    if (verdict.decision === "deny") {
      outcome = record("deny", failure(`Not allowed by policy: ${verdict.reason}`));
    } else if (verdict.decision === "needs_approval" && approval !== "approved") {
      outcome = record(
        "rejected",
        failure("approval_rejected: staff reviewed this action and declined it."),
      );
    } else {
      outcome = record(
        verdict.decision === "needs_approval" ? "approved" : "allow",
        await run(next.tool, next.input),
      );
    }
  } else if (block.name !== RESOLVE_TOOL) {
    outcome = isObject(block.input)
      ? failure(`Unknown tool "${block.name}".`)
      : failure("The tool input must be a JSON object.");
  } else if (state.batch) {
    // Resolving in the same breath as another call means deciding before
    // seeing that call's result.
    outcome = failure(
      `${RESOLVE_TOOL} must be called alone, after you have seen the results of your other tool calls.`,
    );
  } else {
    const parsed = resolutionSchema.safeParse(block.input);
    if (parsed.success) state.resolution = parsed.data;
    outcome = parsed.success
      ? { content: "Recorded.", isError: false }
      : failure(`Invalid resolution: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  }

  state.pending.shift();
  state.results.push({
    type: "tool_result",
    toolUseId: block.id,
    content: outcome.content,
    ...(outcome.isError ? { isError: true } : {}),
  });

  if (state.pending.length === 0) {
    state.messages.push({ role: "user", content: state.results });
    state.results = [];
    if (state.resolution) state.stopped = "resolved";
  }
}

export type AgentRun = Omit<ModelStep, "tools"> & {
  /** The first user message: the ticket, wrapped and dated. */
  ticket: string;
  tools: AgentTool[];
  authorize: Authorize;
  requestApproval: RequestApproval;
};

export type AgentResult = {
  stopped: StopCause;
  resolution?: Resolution;
  turns: number;
  toolCalls: ToolCallRecord[];
  messages: Message[];
};

/**
 * The agent loop: ask the model, run the tools it asks for, give it the
 * results, repeat. Every control sits in plain sight between a model response
 * and a tool call: the tool must exist, policy must allow the call, a person
 * approves when policy says so, and the run is bounded in turns and money.
 *
 * This runs the steps back to back in one process. The durable workflow runs
 * the same steps as separate activities, with the state saved in between.
 */
export async function runAgent(run: AgentRun): Promise<AgentResult> {
  const tools = new Map(run.tools.map((tool) => [tool.definition.name, tool]));
  const state = initialState(run.ticket);
  const step: ModelStep = { ...run, tools: run.tools.map((tool) => tool.definition) };

  while (!state.stopped) {
    await modelStep(state, step);
    while (state.pending.length > 0) {
      const next = await inspectNext(state, (name) => tools.has(name), run.authorize);
      const approval =
        next.kind === "tool" && next.verdict.decision === "needs_approval"
          ? await run.requestApproval({ tool: next.tool, input: next.input }, next.verdict.reason)
          : undefined;
      await settleNext(
        state,
        next,
        async (name, input) =>
          (await tools.get(name)?.call(input)) ?? failure(`Unknown tool "${name}".`),
        approval,
      );
    }
  }

  return {
    stopped: state.stopped,
    turns: state.turns,
    toolCalls: state.toolCalls,
    messages: state.messages,
    ...(state.resolution ? { resolution: state.resolution } : {}),
  };
}
