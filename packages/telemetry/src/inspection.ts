import { createHash } from "node:crypto";
import { ROOT_CONTEXT, SpanStatusCode, TraceFlags, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  type IdGenerator,
  RandomIdGenerator,
  type SpanExporter,
  TracerProvider,
} from "@opentelemetry/sdk-trace";

// The inspection store: where a person can read what the model was sent and
// what it answered, turn by turn.
//
// This is the opposite of the telemetry in index.ts, on purpose. That one
// goes to dashboards and can carry no content at all. This one carries the
// whole conversation, and so it is treated as a second copy of customer
// data: it is sent to one place, only when that place is configured, each
// company's conversations go to their own project, and a deletion request
// removes them.
//
// Spans follow the OpenInference conventions, which is what Arize Phoenix
// and similar tools read.

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string; isError?: boolean }
  | { type: "opaque"; provider: string; data: unknown };

export type InspectedMessage = { role: "user" | "assistant"; content: Block[] };

export type InspectedModelCall = {
  tenantId: string;
  ticketId: string;
  /** The model asked for, and the one that answered. */
  requestedModel: string;
  model: string;
  system?: string | undefined;
  messages: InspectedMessage[];
  tools: { name: string; description: string; inputSchema: unknown }[];
  output: Block[];
  stopReason: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
  startedAt: Date;
  endedAt: Date;
};

export type InspectedToolCall = {
  tenantId: string;
  ticketId: string;
  name: string;
  input: unknown;
  /** What the policy layer decided: allow, deny, approved or rejected. */
  verdict: string;
  output: string;
  failed: boolean;
  startedAt: Date;
  endedAt: Date;
};

export type InspectedTicket = {
  tenantId: string;
  ticketId: string;
  category: string;
  /** The ticket as the customer wrote it. */
  input: string;
  /** The reply the customer received. */
  output: string;
  outcome: string;
  reason: string;
  /** What the reply guard objected to, if anything. */
  violations: string[];
  versions: Record<string, string>;
  /**
   * 0 for the ticket's first answer. Later rounds, after the customer
   * replied, are recorded under the same trace and not as a second root.
   */
  round?: number;
  startedAt: Date;
  endedAt: Date;
};

export interface Inspection {
  modelCall(call: InspectedModelCall): void;
  toolCall(call: InspectedToolCall): void;
  /** Closes a ticket's trace with its root span: what was asked and what was answered. */
  ticket(ticket: InspectedTicket): void;
  /** Removes a ticket's conversation from the store. Returns whether there was one. */
  deleteTicket(tenantId: string, ticketId: string): Promise<boolean>;
  /** Sends whatever is still waiting to be sent. */
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

/** Sends nothing anywhere. This is what runs unless an inspection store is configured. */
export const noInspection: Inspection = {
  modelCall() {},
  toolCall() {},
  ticket() {},
  deleteTicket: async () => false,
  flush: async () => {},
  shutdown: async () => {},
};

/** The ids of a ticket's trace. Shared with the dashboards' traces, so the two can be matched. */
export function ticketTraceIds(ticketId: string): { traceId: string; spanId: string } {
  const digest = createHash("sha256").update(`proofdesk-ticket:${ticketId}`).digest("hex");
  return { traceId: digest.slice(0, 32), spanId: digest.slice(32, 48) };
}

/** The project a company's conversations are kept in. One per company, so access can differ. */
export const projectFor = (tenantId: string) => `proofdesk-${tenantId}`;

class RootIdGenerator implements IdGenerator {
  readonly #random = new RandomIdGenerator();
  next: { traceId: string; spanId: string } | undefined;

  generateTraceId(): string {
    return this.next?.traceId ?? this.#random.generateTraceId();
  }

  generateSpanId(): string {
    return this.next?.spanId ?? this.#random.generateSpanId();
  }
}

type AttributeValue = string | number | boolean;

const json = (value: unknown) => JSON.stringify(value);

/** One message in OpenInference's flattened form, under `prefix`. */
function messageAttributes(
  prefix: string,
  role: string,
  blocks: Block[],
): Record<string, AttributeValue> {
  const attributes: Record<string, AttributeValue> = { [`${prefix}.message.role`]: role };
  const text = blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  if (text) attributes[`${prefix}.message.content`] = text;
  blocks
    .filter((block) => block.type === "tool_use")
    .forEach((block, index) => {
      const call = `${prefix}.message.tool_calls.${index}.tool_call`;
      attributes[`${call}.id`] = block.id;
      attributes[`${call}.function.name`] = block.name;
      attributes[`${call}.function.arguments`] = json(block.input);
    });
  return attributes;
}

/**
 * A conversation as a flat list of messages. A user turn that carries tool
 * results becomes one "tool" message per result, which is how these tools
 * expect to see them.
 */
function flatten(system: string | undefined, messages: InspectedMessage[]) {
  const flat: { role: string; blocks: Block[]; toolCallId?: string }[] = [];
  if (system) flat.push({ role: "system", blocks: [{ type: "text", text: system }] });
  for (const message of messages) {
    const results = message.content.filter((block) => block.type === "tool_result");
    const rest = message.content.filter((block) => block.type !== "tool_result");
    for (const result of results) {
      flat.push({
        role: "tool",
        blocks: [{ type: "text", text: result.content }],
        toolCallId: result.toolUseId,
      });
    }
    if (rest.length > 0 || results.length === 0) flat.push({ role: message.role, blocks: rest });
  }
  return flat;
}

/** A deleted trace must be absent this many times in a row before it counts as gone. */
const DELETE_QUIET_CHECKS = 4;
/** After this many looks the store is still taking the trace in, and the caller should try later. */
const DELETE_MAX_CHECKS = 40;

export function startInspection(options: {
  /** The store's base URL, such as http://phoenix:6006. Nothing is sent without it. */
  endpoint?: string | undefined;
  apiKey?: string | undefined;
  /** For tests: where spans go instead of over the network. */
  exporter?: (project: string) => SpanExporter;
  /** How long to wait between two looks at a trace that is being deleted. */
  deleteIntervalMs?: number;
}): Inspection {
  if (!options.endpoint && !options.exporter) return noInspection;
  const base = options.endpoint?.replace(/\/$/, "");
  const headers: Record<string, string> = options.apiKey
    ? { authorization: `Bearer ${options.apiKey}` }
    : {};
  const deleteIntervalMs = options.deleteIntervalMs ?? 500;

  // One pipeline per company: each writes to its own project.
  const tenants = new Map<string, { provider: TracerProvider; ids: RootIdGenerator }>();
  function pipeline(tenantId: string) {
    let found = tenants.get(tenantId);
    if (!found) {
      const project = projectFor(tenantId);
      const ids = new RootIdGenerator();
      const provider = new TracerProvider({
        idGenerator: ids,
        resource: resourceFromAttributes({
          "service.name": "proofdesk-agent",
          "openinference.project.name": project,
        }),
        spanProcessors: [
          new BatchSpanProcessor({
            exporter:
              options.exporter?.(project) ??
              new OTLPTraceExporter({ url: `${base}/v1/traces`, headers }),
            scheduledDelayMillis: 1000,
          }),
        ],
      });
      found = { provider, ids };
      tenants.set(tenantId, found);
    }
    return found;
  }

  function child(
    tenantId: string,
    ticketId: string,
    name: string,
    attributes: Record<string, AttributeValue>,
    startedAt: Date,
    endedAt: Date,
    failed = false,
  ) {
    const parent = trace.setSpanContext(ROOT_CONTEXT, {
      ...ticketTraceIds(ticketId),
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    });
    const span = pipeline(tenantId)
      .provider.getTracer("proofdesk")
      .startSpan(
        name,
        { attributes: { "session.id": ticketId, ...attributes }, startTime: startedAt },
        parent,
      );
    span.setStatus({ code: failed ? SpanStatusCode.ERROR : SpanStatusCode.OK });
    span.end(endedAt);
  }

  return {
    modelCall(call) {
      const attributes: Record<string, AttributeValue> = {
        "openinference.span.kind": "LLM",
        "llm.system": "anthropic",
        "llm.model_name": call.model,
        "llm.invocation_parameters": json({ requested_model: call.requestedModel }),
        "llm.token_count.prompt":
          call.usage.inputTokens + call.usage.cacheReadTokens + call.usage.cacheWriteTokens,
        "llm.token_count.completion": call.usage.outputTokens,
        "llm.token_count.total":
          call.usage.inputTokens +
          call.usage.cacheReadTokens +
          call.usage.cacheWriteTokens +
          call.usage.outputTokens,
        "llm.token_count.prompt_details.cache_read": call.usage.cacheReadTokens,
        "llm.token_count.prompt_details.cache_write": call.usage.cacheWriteTokens,
        "output.value": json(call.output.filter((block) => block.type !== "opaque")),
        "output.mime_type": "application/json",
        metadata: json({ stop_reason: call.stopReason }),
      };
      flatten(call.system, call.messages).forEach((message, index) => {
        const prefix = `llm.input_messages.${index}`;
        Object.assign(attributes, messageAttributes(prefix, message.role, message.blocks));
        if (message.toolCallId) attributes[`${prefix}.message.tool_call_id`] = message.toolCallId;
      });
      Object.assign(
        attributes,
        messageAttributes("llm.output_messages.0", "assistant", call.output),
      );
      call.tools.forEach((tool, index) => {
        attributes[`llm.tools.${index}.tool.json_schema`] = json({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema,
        });
      });
      child(
        call.tenantId,
        call.ticketId,
        `model ${call.model}`,
        attributes,
        call.startedAt,
        call.endedAt,
      );
    },

    toolCall(call) {
      child(
        call.tenantId,
        call.ticketId,
        call.name,
        {
          "openinference.span.kind": "TOOL",
          "tool.name": call.name,
          "input.value": json(call.input),
          "input.mime_type": "application/json",
          "output.value": call.output,
          metadata: json({ verdict: call.verdict }),
        },
        call.startedAt,
        call.endedAt,
        call.failed,
      );
    },

    ticket(ticket) {
      if ((ticket.round ?? 0) > 0) {
        child(
          ticket.tenantId,
          ticket.ticketId,
          `follow-up ${ticket.round}`,
          {
            "openinference.span.kind": "AGENT",
            "output.value": ticket.output,
            metadata: json({
              outcome: ticket.outcome,
              reason: ticket.reason,
              reply_guard: ticket.violations,
            }),
          },
          ticket.endedAt,
          ticket.endedAt,
          ticket.violations.length > 0,
        );
        return;
      }
      const { provider, ids } = pipeline(ticket.tenantId);
      // The root takes the ids every other span of the ticket already points at.
      ids.next = ticketTraceIds(ticket.ticketId);
      try {
        const span = provider.getTracer("proofdesk").startSpan(
          "ticket",
          {
            root: true,
            startTime: ticket.startedAt,
            attributes: {
              "openinference.span.kind": "AGENT",
              "session.id": ticket.ticketId,
              "input.value": ticket.input,
              "output.value": ticket.output,
              metadata: json({
                category: ticket.category,
                outcome: ticket.outcome,
                reason: ticket.reason,
                reply_guard: ticket.violations,
                ...ticket.versions,
              }),
              "tag.tags": [ticket.category, ticket.outcome],
            },
          },
          ROOT_CONTEXT,
        );
        span.setStatus({
          code: ticket.violations.length > 0 ? SpanStatusCode.ERROR : SpanStatusCode.OK,
        });
        span.end(ticket.endedAt);
      } finally {
        ids.next = undefined;
      }
    },

    async deleteTicket(tenantId, ticketId) {
      if (!base) return false;
      // Anything still waiting to be sent goes first, so that it is deleted
      // and does not arrive afterwards.
      await tenants.get(tenantId)?.provider.forceFlush();
      // The store takes spans in after it has accepted them, so a trace can
      // still be on its way in when it is deleted: the delete finds nothing,
      // or part of it, and the rest appears a moment later. So the delete is
      // repeated until the store has had nothing for this ticket several
      // times in a row.
      const url = `${base}/v1/traces/${ticketTraceIds(ticketId).traceId}`;
      let removed = false;
      let quiet = 0;
      for (let attempt = 0; quiet < DELETE_QUIET_CHECKS; attempt++) {
        if (attempt >= DELETE_MAX_CHECKS) {
          throw new Error("The inspection store kept receiving a trace that is being deleted");
        }
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, deleteIntervalMs));
        const response = await fetch(url, { method: "DELETE", headers });
        if (response.status === 404) {
          quiet += 1;
        } else if (response.ok) {
          removed = true;
          quiet = 0;
        } else {
          throw new Error(`The inspection store refused to delete a trace (${response.status})`);
        }
      }
      return removed;
    },

    async flush() {
      await Promise.all([...tenants.values()].map(({ provider }) => provider.forceFlush()));
    },

    async shutdown() {
      await Promise.all([...tenants.values()].map(({ provider }) => provider.shutdown()));
    },
  };
}
