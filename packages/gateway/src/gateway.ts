import { ProviderError } from "./errors.ts";
import { costMicros, estimateMicros, type PriceTable } from "./pricing.ts";
import type { CallContext, ModelProvider, ModelRequest, ModelResponse, Usage } from "./types.ts";

/** Thrown before a call is made, when the ticket or tenant has no budget left. */
export class BudgetExceededError extends Error {
  override readonly name = "BudgetExceededError";
  readonly scope: "ticket" | "tenant";
  readonly spentMicros: number;
  readonly limitMicros: number;

  constructor(scope: "ticket" | "tenant", spentMicros: number, limitMicros: number) {
    super(`The ${scope} budget is used up: spent ${spentMicros} of ${limitMicros} micro-dollars`);
    this.scope = scope;
    this.spentMicros = spentMicros;
    this.limitMicros = limitMicros;
  }
}

/** One budget a call counts against: where its spend is kept, and how much there may be. */
export type BudgetHold = { key: string; limitMicros: number };

/** Where spend is recorded. In production this is a table; in tests, memory. */
export interface SpendLedger {
  spent(key: string): Promise<number>;
  /** Adds to a total. The amount may be negative, to give back part of a reservation. */
  add(key: string, micros: number): Promise<void>;
  /**
   * Sets `micros` aside in every budget, if every one of them still has
   * room, and in one step: no other reservation can come between the look
   * and the write. Returns nothing when it did, and otherwise the budget
   * that is used up, with nothing set aside anywhere.
   */
  reserve(
    holds: BudgetHold[],
    micros: number,
  ): Promise<{ key: string; spentMicros: number } | null>;
}

export function createMemoryLedger(): SpendLedger {
  const totals = new Map<string, number>();
  return {
    async spent(key) {
      return totals.get(key) ?? 0;
    },
    async add(key, micros) {
      totals.set(key, (totals.get(key) ?? 0) + micros);
    },
    async reserve(holds, micros) {
      // No await between the look and the write, so nothing can interleave.
      for (const { key, limitMicros } of holds) {
        const spentMicros = totals.get(key) ?? 0;
        if (spentMicros >= limitMicros) return { key, spentMicros };
      }
      for (const { key } of holds) totals.set(key, (totals.get(key) ?? 0) + micros);
      return null;
    },
  };
}

/** One model call as it happened, for traces and cost reports. */
export type CallRecord = {
  provider: string;
  requestedModel: string;
  /** The model the call was sent to, which differs from the request on a backup route. */
  sentModel: string;
  /** The model that answered, as the provider named it. */
  model?: string;
  attempt: number;
  latencyMs: number;
  usage?: Usage;
  costMicros?: number;
  error?: string;
  context: CallContext;
};

export type GatewayRoute = {
  provider: ModelProvider;
  /**
   * For a backup route: which of its models stands in for each requested
   * model. A requested model with no entry is not sent to this route. A
   * backup may be another provider, or the same provider with other models.
   */
  models?: Record<string, string>;
};

export type GatewayOptions = {
  /** Tried in order. The first is the primary; the rest are backups. */
  routes: [GatewayRoute, ...GatewayRoute[]];
  prices: PriceTable;
  ledger: SpendLedger;
  limits: { perTicketMicros: number; perTenantMicros: number };
  /** Attempts per route, including the first. */
  maxAttempts?: number;
  baseDelayMs?: number;
  onCall?: (record: CallRecord) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
};

/** The longest a provider's "retry after" is obeyed. Beyond it, the backup route is the better bet. */
const MAX_RETRY_AFTER_MS = 30_000;

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

/**
 * The one door to the model. Every call is checked against the ticket's and
 * the tenant's budget, retried on transient failures, moved to a backup
 * route if the primary stays down, priced, and recorded.
 */
export function createGateway(options: GatewayOptions): ModelProvider {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;

  const ticketKey = (context: CallContext) => `ticket:${context.tenantId}:${context.ticketId}`;
  const tenantKey = (context: CallContext) => `tenant:${context.tenantId}`;

  /**
   * Sets the call's estimated cost aside in the ticket's and the tenant's
   * budget, or refuses the call. A call under way therefore already counts
   * against the budget, and calls made at the same moment cannot each see
   * room that only one of them can have. A budget is still overrun by at
   * most the one call that takes it past its limit, as it is when calls
   * come one after another.
   */
  async function reserve(context: CallContext, micros: number): Promise<void> {
    const ticket = { key: ticketKey(context), limitMicros: options.limits.perTicketMicros };
    const tenant = { key: tenantKey(context), limitMicros: options.limits.perTenantMicros };
    const full = await options.ledger.reserve([ticket, tenant], micros);
    if (!full) return;
    const [scope, hold] =
      full.key === ticket.key ? (["ticket", ticket] as const) : (["tenant", tenant] as const);
    throw new BudgetExceededError(scope, full.spentMicros, hold.limitMicros);
  }

  /** Replaces a reservation with what the call really cost, or with nothing. */
  async function settle(context: CallContext, reserved: number, cost: number): Promise<void> {
    await options.ledger.add(ticketKey(context), cost - reserved);
    await options.ledger.add(tenantKey(context), cost - reserved);
  }

  return {
    name: "gateway",

    async complete(request: ModelRequest, context: CallContext): Promise<ModelResponse> {
      let lastError: unknown;

      for (const [index, route] of options.routes.entries()) {
        const model = index === 0 ? request.model : route.models?.[request.model];
        if (!model) continue;
        const price = options.prices[model];
        // A call that cannot be priced cannot be budgeted, so it is not made.
        if (!price) {
          throw new ProviderError(
            route.provider.name,
            "invalid_request",
            `No price is configured for model "${model}"`,
          );
        }

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          context.signal?.throwIfAborted();
          const reserved = estimateMicros(price, { ...request, model });
          await reserve(context, reserved);

          const started = now();
          const record: CallRecord = {
            provider: route.provider.name,
            requestedModel: request.model,
            sentModel: model,
            attempt,
            latencyMs: 0,
            context,
          };
          let response: ModelResponse;
          try {
            response = await route.provider.complete({ ...request, model }, context);
          } catch (error) {
            lastError = error;
            // A call that failed cost nothing, so its reservation is given back.
            await settle(context, reserved, 0);
            options.onCall?.({
              ...record,
              latencyMs: now() - started,
              error: error instanceof ProviderError ? error.kind : "unknown",
            });
            // Only failures that may pass are retried or moved to a backup.
            // A malformed request would fail everywhere, and an aborted call
            // must stop.
            if (!(error instanceof ProviderError) || !error.retryable) throw error;
            if (attempt < maxAttempts) {
              const backoff = baseDelayMs * 2 ** (attempt - 1);
              const jittered = backoff / 2 + random() * (backoff / 2);
              // A provider that says when to come back is taken at its word,
              // up to a limit: sooner would only fail again.
              const asked = Math.min(error.retryAfterMs ?? 0, MAX_RETRY_AFTER_MS);
              await sleep(Math.max(jittered, asked), context.signal);
            }
            continue;
          }
          const cost = costMicros(price, response.usage);
          await settle(context, reserved, cost);
          options.onCall?.({
            ...record,
            model: response.model,
            latencyMs: now() - started,
            usage: response.usage,
            costMicros: cost,
          });
          return response;
        }
      }

      throw lastError;
    },
  };
}
