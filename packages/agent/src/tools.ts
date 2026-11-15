import type { ToolDefinition } from "@proofdesk/gateway";

export type ToolOutcome = { content: string; isError: boolean };

/** A tool as the agent loop sees it. */
export type AgentTool = {
  definition: ToolDefinition;
  /** True when a successful call changes a system of record. */
  writes: boolean;
  call(input: Record<string, unknown>): Promise<ToolOutcome>;
};

/** The verdict of the policy layer on one proposed tool call. */
export type Verdict =
  | { decision: "allow" }
  | { decision: "deny"; reason: string }
  | { decision: "needs_approval"; reason: string };

export type ProposedCall = { tool: string; input: Record<string, unknown> };

/** Decides whether a tool call may run. Called before every tool call, reads included. */
export type Authorize = (
  call: ProposedCall,
  history: ToolCallRecord[],
) => Promise<Verdict> | Verdict;

/** Asks a person. Resolves when they have answered, however long that takes. */
export type RequestApproval = (
  call: ProposedCall,
  reason: string,
) => Promise<"approved" | "rejected">;

export type ToolCallRecord = {
  tool: string;
  input: Record<string, unknown>;
  verdict: "allow" | "deny" | "approved" | "rejected";
  outcome: ToolOutcome;
};

type ObjectSchema = { properties?: Record<string, unknown>; required?: string[] };

/**
 * Drops the sentence that explains the idempotency key from a tool's
 * description. A description comes from a server, so it is searched with
 * plain string functions, whose cost does not depend on what it contains.
 */
function withoutKeySentence(description: string): string {
  const start = description.indexOf("Repeating a call");
  const end = start < 0 ? -1 : description.indexOf(".", start);
  if (end < 0) return description;
  return description.slice(0, start).trimEnd() + description.slice(end + 1);
}

/**
 * Removes the idempotency key from what the model is shown. The model cannot
 * choose the key, so it cannot defeat it.
 */
export function hideIdempotencyKey(definition: ToolDefinition): ToolDefinition {
  const schema = definition.inputSchema as ObjectSchema;
  if (!schema.properties?.idempotencyKey) return definition;
  const { idempotencyKey: _hidden, ...properties } = schema.properties;
  return {
    ...definition,
    description: withoutKeySentence(definition.description),
    inputSchema: {
      ...schema,
      properties,
      required: (schema.required ?? []).filter((name) => name !== "idempotencyKey"),
    },
  };
}

/**
 * The input a tool actually receives: the model's arguments plus a key
 * derived from the ticket and those arguments. A retried or repeated
 * identical call reuses its key and so cannot take effect twice.
 */
export function withIdempotencyKey(
  ticketId: string,
  tool: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const { idempotencyKey: _ignored, ...rest } = input;
  const parts = Object.keys(rest)
    .sort()
    .map((key) => `${key}=${JSON.stringify(rest[key])}`);
  return { ...rest, idempotencyKey: `${ticketId}:${tool}:${parts.join(",")}` };
}

/** Takes the idempotency key out of the model's hands for one in-process tool. */
export function withSystemIdempotency(tool: AgentTool, ticketId: string): AgentTool {
  const schema = tool.definition.inputSchema as ObjectSchema;
  if (!schema.properties?.idempotencyKey) return tool;
  return {
    ...tool,
    definition: hideIdempotencyKey(tool.definition),
    call: (input) => tool.call(withIdempotencyKey(ticketId, tool.definition.name, input)),
  };
}
