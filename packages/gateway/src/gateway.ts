import { ProviderError } from "./errors.ts";
import { costMicros, type PriceTable } from "./pricing.ts";
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

/** Where spend is recorded. In production this is a table; in tests, memory. */
export interface SpendLedger {
  spent(key: string): Promise<number>;
  add(key: string, micros: number): Promise<void>;
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
  };
}

/** One model call as it happened, for traces and cost reports. */
export type CallRecord = {
  provider: string;
  requestedModel: string;
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
   * For a backup provider: which of its models stands in for each requested
   * model. A requested model with no entry is not sent to this provider.
   */
  models?: Record<string, string>;
};

export type GatewayOptions = {
  /** Tried in order. The first is the primary; the rest are backups. */
  routes: [GatewayRoute, ...GatewayRoute[]];
  prices: PriceTable;
  ledger: SpendLedger;
  limits: { perTicketMicros: number; perTenantMicros: number };
  /** Attempts per provider, including the first. */
  maxAttempts?: number;
  baseDelayMs?: number;
  onCall?: (record: CallRecord) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
};

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
 * provider if the primary stays down, priced, and recorded.
 */
export function createGateway(options: GatewayOptions): ModelProvider {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;

  const ticketKey = (context: CallContext) => `ticket:${context.tenantId}:${context.ticketId}`;
  const tenantKey = (context: CallContext) => `tenant:${context.tenantId}`;

  async function checkBudget(context: CallContext): Promise<void> {
    const ticket = await options.ledger.spent(ticketKey(context));
    if (ticket >= options.limits.perTicketMicros) {
      throw new BudgetExceededError("ticket", ticket, options.limits.perTicketMicros);
    }
    const tenant = await options.ledger.spent(tenantKey(context));
    if (tenant >= options.limits.perTenantMicros) {
      throw new BudgetExceededError("tenant", tenant, options.limits.perTenantMicros);
    }
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
          await checkBudget(context);

          const started = now();
          const record: CallRecord = {
            provider: route.provider.name,
            requestedModel: request.model,
            attempt,
            latencyMs: 0,
            context,
          };
          try {
            const response = await route.provider.complete({ ...request, model }, context);
            const cost = costMicros(price, response.usage);
            await options.ledger.add(ticketKey(context), cost);
            await options.ledger.add(tenantKey(context), cost);
            options.onCall?.({
              ...record,
              model: response.model,
              latencyMs: now() - started,
              usage: response.usage,
              costMicros: cost,
            });
            return response;
          } catch (error) {
            lastError = error;
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
              await sleep(backoff / 2 + random() * (backoff / 2), context.signal);
            }
          }
        }
      }

      throw lastError;
    },
  };
}
