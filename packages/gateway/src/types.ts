/**
 * Provider-neutral model types. Every model call in the repo goes through
 * these, so the agent loop never depends on one vendor's SDK.
 */

export type TextBlock = { type: "text"; text: string };

export type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  /** Unvalidated model output. The caller checks it against the tool's schema. */
  input: unknown;
};

export type ToolResultBlock = {
  type: "tool_result";
  toolUseId: string;
  content: string;
  isError?: boolean;
};

export type AssistantBlock = TextBlock | ToolUseBlock;
export type UserBlock = TextBlock | ToolResultBlock;

export type Message =
  | { role: "user"; content: UserBlock[] }
  | { role: "assistant"; content: AssistantBlock[] };

export type ToolDefinition = {
  name: string;
  description: string;
  /** JSON Schema for the tool input. */
  inputSchema: Record<string, unknown>;
};

export type ModelRequest = {
  model: string;
  system?: string;
  messages: Message[];
  tools?: ToolDefinition[];
  maxTokens: number;
};

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal";

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type ModelResponse = {
  /** The model that answered, which differs from the request after a failover. */
  model: string;
  content: AssistantBlock[];
  stopReason: StopReason;
  usage: Usage;
};

/** Who the call is for. Budgets, rate limits and traces are keyed on this. */
export type CallContext = {
  tenantId: string;
  ticketId: string;
  signal?: AbortSignal;
};

export interface ModelProvider {
  readonly name: string;
  complete(request: ModelRequest, context: CallContext): Promise<ModelResponse>;
}
