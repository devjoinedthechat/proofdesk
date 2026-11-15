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

/** An amount set aside in one or more budgets for a call that is under way. */
export type Reservation = { id: string; keys: string[] };

/** Where spend is recorded. In production this is a table; in tests, memory. */
export interface SpendLedger {
  /** What a budget has used: what calls cost, plus what calls under way have set aside. */
  spent(key: string): Promise<number>;
  /** Adds what a call cost to a total. */
  add(key: string, micros: number): Promise<void>;
  /**
   * Sets `micros` aside in every budget, if every one of them still has
   * room, and in one step: no other reservation can come between the look
   * and the write. Returns the reservation when it did, and otherwise the
   * budget that is used up, with nothing set aside anywhere.
   *
   * A reservation counts for `ttlMs` and then lapses by itself, so a caller
   * that dies before it settles does not hold its budget down for good.
   */
  reserve(
    holds: BudgetHold[],
    micros: number,
    ttlMs: number,
  ): Promise<{ reservation: Reservation } | { full: { key: string; spentMicros: number } }>;
  /**
   * Replaces a reservation with what the call cost, in one step. The cost is
   * recorded whether or not the reservation has lapsed in the meantime.
   */
  settle(reservation: Reservation, micros: number): Promise<void>;
}

export function createMemoryLedger(now: () => number = Date.now): SpendLedger {
  const totals = new Map<string, number>();
  const reservations = new Map<string, { keys: string[]; micros: number; expiresAt: number }>();
  let issued = 0;
  const used = (key: string) => {
    let sum = totals.get(key) ?? 0;
    for (const held of reservations.values()) {
      if (held.expiresAt > now() && held.keys.includes(key)) sum += held.micros;
    }
    return sum;
  };
  return {
    async spent(key) {
      return used(key);
    },
    async add(key, micros) {
      totals.set(key, (totals.get(key) ?? 0) + micros);
    },
    async reserve(holds, micros, ttlMs) {
      // No await between the look and the write, so nothing can interleave.
      for (const { key, limitMicros } of holds) {
        const spentMicros = used(key);
        if (spentMicros >= limitMicros) return { full: { key, spentMicros } };
      }
      const reservation = { id: `r${++issued}`, keys: holds.map((hold) => hold.key) };
      reservations.set(reservation.id, {
        keys: reservation.keys,
        micros,
        expiresAt: now() + ttlMs,
      });
      return { reservation };
    },
    async settle(reservation, micros) {
      reservations.delete(reservation.id);
      for (const key of reservation.keys) totals.set(key, (totals.get(key) ?? 0) + micros);
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
  /** How long a call's reservation counts before it lapses. Longer than any one call may take. */
  reservationTtlMs?: number;
  onCall?: (record: CallRecord) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
};

/** The longest a provider's "retry after" is obeyed. Beyond it, the backup route is the better bet. */
const MAX_RETRY_AFTER_MS = 30_000;

/**
 * How long a reservation counts when nobody settles it. A provider gives up
 * on a call well before this, so a reservation still there afterwards belongs
 * to a worker that died, and the budget gets it back.
 */
const RESERVATION_TTL_MS = 5 * 60_000;

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
  const reservationTtlMs = options.reservationTtlMs ?? RESERVATION_TTL_MS;

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
  async function reserve(context: CallContext, micros: number): Promise<Reservation> {
    const ticket = { key: ticketKey(context), limitMicros: options.limits.perTicketMicros };
    const tenant = { key: tenantKey(context), limitMicros: options.limits.perTenantMicros };
    const result = await options.ledger.reserve([ticket, tenant], micros, reservationTtlMs);
    if ("reservation" in result) return result.reservation;
    const { full } = result;
    const [scope, hold] =
      full.key === ticket.key ? (["ticket", ticket] as const) : (["tenant", tenant] as const);
    throw new BudgetExceededError(scope, full.spentMicros, hold.limitMicros);
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
          const reservation = await reserve(context, estimateMicros(price, { ...request, model }));

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
            await options.ledger.settle(reservation, 0);
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
          await options.ledger.settle(reservation, cost);
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
