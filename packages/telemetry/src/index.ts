import { createHash } from "node:crypto";
import {
  type Meter,
  ROOT_CONTEXT,
  SpanStatusCode,
  TraceFlags,
  type Tracer,
  trace,
} from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  BatchSpanProcessor,
  type IdGenerator,
  InMemorySpanExporter,
  RandomIdGenerator,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";

/**
 * Everything that may leave the process as telemetry. A trace or a metric
 * can carry these attributes and no others.
 *
 * The list holds identifiers, fixed vocabularies and numbers. It has no
 * place for a ticket's text, a reply, a name or an email address, so those
 * cannot be attached by mistake.
 */
export type Attributes = Partial<{
  "tenant.id": string;
  "ticket.id": string;
  "ticket.route": string;
  "run.step": number;
  /** An audit event's name, such as `tool_call`. */
  event: string;
  "tool.name": string;
  "tool.verdict": string;
  "tool.failed": boolean;
  outcome: string;
  reason: string;
  cause: string;
  scope: string;
  "model.requested": string;
  "model.sent": string;
  "model.answered": string;
  "model.attempt": number;
  "model.error": string;
  "tokens.kind": string;
  "activity.name": string;
  "watchdog.action": string;
}>;

/** Attributes that identify one ticket. Kept on traces, left off metrics. */
const PER_TICKET: readonly (keyof Attributes)[] = ["ticket.id", "run.step", "model.attempt"];

/**
 * What an identifier looks like: no spaces, no punctuation beyond a few
 * separators. A sentence does not match, so even a string attribute cannot
 * carry free text out. A value that fails is replaced and counted.
 */
const IDENTIFIER = /^[A-Za-z0-9_.:*@/-]{1,160}$/;
export const REDACTED = "[redacted]";

export const METRICS = {
  /** One per audit entry: what the agent, staff and the system did. */
  events: "proofdesk.events",
  /** Refunds the agent paid, in cents. */
  refundCents: "proofdesk.refund.cents",
  modelCalls: "proofdesk.model.calls",
  /** Model spend in millionths of a dollar. */
  modelCostMicros: "proofdesk.model.cost.micros",
  modelTokens: "proofdesk.model.tokens",
  modelLatencyMs: "proofdesk.model.latency",
  activityLatencyMs: "proofdesk.activity.latency",
  /** String attributes that were not identifiers and were replaced. Should stay at zero. */
  redactions: "proofdesk.telemetry.redactions",
} as const;

export type CounterName = Exclude<keyof typeof METRICS, "modelLatencyMs" | "activityLatencyMs">;
export type HistogramName = "modelLatencyMs" | "activityLatencyMs";

export interface Telemetry {
  /** Runs `fn` inside a span that belongs to the ticket's trace, when a ticket is named. */
  span<Result>(
    name: string,
    attributes: Attributes,
    fn: (set: (more: Attributes) => void) => Promise<Result>,
  ): Promise<Result>;
  /**
   * Opens a ticket's trace with its root span. Called once, when work on the
   * ticket starts; every later span about the ticket hangs under it.
   */
  ticket(ticketId: string, attributes: Attributes): void;
  /** Records a span for something that already happened. */
  spanAt(
    name: string,
    attributes: Attributes,
    startedAt: Date,
    endedAt: Date,
    error?: string,
  ): void;
  count(name: CounterName, value: number, attributes: Attributes): void;
  record(name: HistogramName, value: number, attributes: Attributes): void;
}

/** Telemetry that does nothing, for when none is configured. */
export const noTelemetry: Telemetry = {
  span: (_name, _attributes, fn) => fn(() => {}),
  ticket() {},
  spanAt() {},
  count() {},
  record() {},
};

/**
 * One trace per ticket. A ticket's work is spread over many activities,
 * retries, days and possibly several workers, so there is no call stack to
 * carry a trace along. The trace id is derived from the ticket id instead:
 * every span about a ticket, from any process at any time, lands in the same
 * trace.
 */
function ticketIds(ticketId: string) {
  const digest = createHash("sha256").update(`proofdesk-ticket:${ticketId}`).digest("hex");
  return { traceId: digest.slice(0, 32), spanId: digest.slice(32, 48) };
}

function ticketContext(ticketId: string) {
  return trace.setSpanContext(ROOT_CONTEXT, {
    ...ticketIds(ticketId),
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  });
}

/**
 * Hands out random ids, except for the one span it has been told about in
 * advance: a ticket's root span, whose ids are derived from the ticket.
 * Starting a span is synchronous, so the ids set here are used by the very
 * next span and no other.
 */
class TicketIdGenerator implements IdGenerator {
  readonly #random = new RandomIdGenerator();
  next: { traceId: string; spanId: string } | undefined;

  generateTraceId(): string {
    return this.next?.traceId ?? this.#random.generateTraceId();
  }

  generateSpanId(): string {
    return this.next?.spanId ?? this.#random.generateSpanId();
  }
}

export function createTelemetry(tracer: Tracer, meter: Meter, ids?: TicketIdGenerator): Telemetry {
  const counters = new Map<string, ReturnType<Meter["createCounter"]>>();
  const histograms = new Map<string, ReturnType<Meter["createHistogram"]>>();
  const counter = (name: CounterName) => {
    let instrument = counters.get(name);
    if (!instrument) {
      instrument = meter.createCounter(METRICS[name]);
      counters.set(name, instrument);
    }
    return instrument;
  };
  const histogram = (name: HistogramName) => {
    let instrument = histograms.get(name);
    if (!instrument) {
      instrument = meter.createHistogram(METRICS[name], { unit: "ms" });
      histograms.set(name, instrument);
    }
    return instrument;
  };

  function clean(attributes: Attributes, forMetric: boolean) {
    const result: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(attributes)) {
      if (value === undefined) continue;
      if (forMetric && PER_TICKET.includes(key as keyof Attributes)) continue;
      if (typeof value === "string" && !IDENTIFIER.test(value)) {
        result[key] = REDACTED;
        counter("redactions").add(1, { attribute: key });
      } else {
        result[key] = value;
      }
    }
    return result;
  }
  const parent = (attributes: Attributes) =>
    attributes["ticket.id"] ? ticketContext(attributes["ticket.id"]) : ROOT_CONTEXT;

  return {
    async span(name, attributes, fn) {
      const span = tracer.startSpan(
        name,
        { attributes: clean(attributes, false) },
        parent(attributes),
      );
      try {
        return await fn((more) => span.setAttributes(clean(more, false)));
      } catch (error) {
        // The error's type and nothing else: a message can quote anything.
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.name : "Error",
        });
        throw error;
      } finally {
        span.end();
      }
    },
    ticket(ticketId, attributes) {
      // Without a generator that takes the ticket's ids there is no way to
      // make this span the root, and a second root would split the trace.
      if (!ids) return;
      ids.next = ticketIds(ticketId);
      try {
        tracer
          .startSpan(
            "ticket",
            { attributes: clean({ ...attributes, "ticket.id": ticketId }, false), root: true },
            ROOT_CONTEXT,
          )
          .end();
      } finally {
        ids.next = undefined;
      }
    },
    spanAt(name, attributes, startedAt, endedAt, error) {
      const span = tracer.startSpan(
        name,
        { attributes: clean(attributes, false), startTime: startedAt },
        parent(attributes),
      );
      if (error) span.setStatus({ code: SpanStatusCode.ERROR, message: error });
      span.end(endedAt);
    },
    count(name, value, attributes) {
      counter(name).add(value, clean(attributes, true));
    },
    record(name, value, attributes) {
      histogram(name).record(value, clean(attributes, true));
    },
  };
}

/**
 * Telemetry exported over OTLP to a collector, or none at all when no
 * endpoint is configured.
 */
export function startTelemetry(options: { serviceName: string; endpoint?: string | undefined }): {
  telemetry: Telemetry;
  shutdown(): Promise<void>;
} {
  if (!options.endpoint) return { telemetry: noTelemetry, shutdown: async () => {} };
  const base = options.endpoint.replace(/\/$/, "");
  const resource = resourceFromAttributes({ "service.name": options.serviceName });
  const ids = new TicketIdGenerator();
  const tracers = new TracerProvider({
    resource,
    idGenerator: ids,
    spanProcessors: [
      new BatchSpanProcessor({ exporter: new OTLPTraceExporter({ url: `${base}/v1/traces` }) }),
    ],
  });
  const meters = new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: `${base}/v1/metrics` }),
        exportIntervalMillis: 10_000,
      }),
    ],
  });
  return {
    telemetry: createTelemetry(tracers.getTracer("proofdesk"), meters.getMeter("proofdesk"), ids),
    async shutdown() {
      await Promise.all([tracers.shutdown(), meters.shutdown()]);
    },
  };
}

/** Telemetry kept in memory, for tests that check what would have been exported. */
export function createTestTelemetry() {
  const spans = new InMemorySpanExporter();
  const metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({
    exporter: metrics,
    exportIntervalMillis: 3_600_000,
  });
  const ids = new TicketIdGenerator();
  const tracers = new TracerProvider({
    idGenerator: ids,
    spanProcessors: [new SimpleSpanProcessor({ exporter: spans })],
  });
  const meters = new MeterProvider({ readers: [reader] });

  return {
    telemetry: createTelemetry(tracers.getTracer("test"), meters.getMeter("test"), ids),
    spans: () =>
      spans.getFinishedSpans().map((span) => ({
        name: span.name,
        traceId: span.spanContext().traceId,
        spanId: span.spanContext().spanId,
        parentSpanId: span.parentSpanContext?.spanId,
        attributes: span.attributes,
        status: span.status,
      })),
    /** Every metric data point so far, flattened. */
    async points() {
      await reader.forceFlush();
      const latest = metrics.getMetrics().at(-1);
      return (latest?.scopeMetrics ?? []).flatMap((scope) =>
        scope.metrics.flatMap((metric) =>
          metric.dataPoints.map((point) => ({
            name: metric.descriptor.name,
            attributes: point.attributes,
            value: point.value,
          })),
        ),
      );
    },
    /** Everything exported, as one string, for searching. */
    async everything() {
      return JSON.stringify({ spans: this.spans(), points: await this.points() });
    },
  };
}
