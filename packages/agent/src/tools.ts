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

/**
 * Takes the idempotency key out of the model's hands. The model does not see
 * the parameter, and the key is derived from the ticket and the call's own
 * arguments. A retried or repeated identical call therefore reuses its key
 * and cannot pay twice, whatever the model does.
 */
export function withSystemIdempotency(tool: AgentTool, ticketId: string): AgentTool {
  const schema = tool.definition.inputSchema as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  if (!schema.properties?.idempotencyKey) return tool;

  const { idempotencyKey: _hidden, ...properties } = schema.properties;
  return {
    ...tool,
    definition: {
      ...tool.definition,
      description: tool.definition.description.replace(/\s*Repeating a call[^.]*\./, ""),
      inputSchema: {
        ...schema,
        properties,
        required: (schema.required ?? []).filter((name) => name !== "idempotencyKey"),
      },
    },
    call(input) {
      const { idempotencyKey: _ignored, ...rest } = input;
      const parts = Object.keys(rest)
        .sort()
        .map((key) => `${key}=${JSON.stringify(rest[key])}`);
      return tool.call({
        ...rest,
        idempotencyKey: `${ticketId}:${tool.definition.name}:${parts.join(",")}`,
      });
    },
  };
}
