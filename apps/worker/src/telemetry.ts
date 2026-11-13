import type { CallRecord } from "@proofdesk/gateway";
import type { Attributes, Telemetry } from "@proofdesk/telemetry";

const text = (value: unknown) => (typeof value === "string" ? value : undefined);

/**
 * Mirrors an audit entry as a metric. The audit log is already limited to
 * identifiers and amounts, so it is the one stream that is safe to count,
 * and counting it keeps the dashboards and the record of what happened from
 * disagreeing.
 */
export function recordEvent(
  telemetry: Telemetry,
  entry: { tenantId: string; ticketId?: string; event: string; detail: Record<string, unknown> },
): void {
  const { detail } = entry;
  const attributes: Attributes = { event: entry.event, "tenant.id": entry.tenantId };
  const set = <Key extends keyof Attributes>(key: Key, value: Attributes[Key] | undefined) => {
    if (value !== undefined) attributes[key] = value;
  };
  set("tool.name", text(detail.tool));
  set("tool.verdict", text(detail.verdict));
  set("tool.failed", typeof detail.failed === "boolean" ? detail.failed : undefined);
  set("outcome", text(detail.outcome));
  set("reason", text(detail.reasonCode));
  set("cause", text(detail.cause));
  set("scope", text(detail.scope));
  telemetry.count("events", 1, attributes);
  // The first event of a run opens the ticket's trace.
  if (entry.event === "run_started" && entry.ticketId) {
    telemetry.ticket(entry.ticketId, { "tenant.id": entry.tenantId });
  }

  if (entry.event === "run_finished" && typeof detail.refundedCents === "number") {
    telemetry.count("refundCents", detail.refundedCents, { "tenant.id": entry.tenantId });
  }
}

/** Records one model call: a span in the ticket's trace, and its cost, tokens and latency. */
export function recordModelCall(telemetry: Telemetry, record: CallRecord, now: Date): void {
  const model: Attributes = {
    "tenant.id": record.context.tenantId,
    "model.requested": record.requestedModel,
    "model.sent": record.sentModel,
    ...(record.error ? { "model.error": record.error } : {}),
  };
  telemetry.spanAt(
    "model.call",
    {
      ...model,
      "ticket.id": record.context.ticketId,
      "model.attempt": record.attempt,
      ...(record.model ? { "model.answered": record.model } : {}),
    },
    new Date(now.getTime() - record.latencyMs),
    now,
    record.error,
  );
  telemetry.count("modelCalls", 1, model);
  telemetry.record("modelLatencyMs", record.latencyMs, model);
  if (record.costMicros !== undefined) telemetry.count("modelCostMicros", record.costMicros, model);
  if (record.usage) {
    for (const [kind, tokens] of Object.entries({
      input: record.usage.inputTokens,
      output: record.usage.outputTokens,
      cache_read: record.usage.cacheReadTokens,
      cache_write: record.usage.cacheWriteTokens,
    })) {
      telemetry.count("modelTokens", tokens, { ...model, "tokens.kind": kind });
    }
  }
}
