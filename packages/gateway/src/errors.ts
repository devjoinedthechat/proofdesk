export type ProviderErrorKind =
  | "rate_limited"
  | "overloaded"
  | "timeout"
  | "unavailable"
  | "invalid_request"
  | "unauthorized";

const RETRYABLE: ReadonlySet<ProviderErrorKind> = new Set([
  "rate_limited",
  "overloaded",
  "timeout",
  "unavailable",
]);

/**
 * The one error type a provider may throw. Providers map their SDK's errors
 * onto a kind, so retry and failover decisions never inspect vendor errors.
 */
export class ProviderError extends Error {
  override readonly name = "ProviderError";
  readonly kind: ProviderErrorKind;
  readonly provider: string;
  /** How long the provider asked callers to wait before trying again, when it said. */
  readonly retryAfterMs?: number;

  constructor(
    provider: string,
    kind: ProviderErrorKind,
    message: string,
    options?: ErrorOptions & { retryAfterMs?: number },
  ) {
    super(message, options);
    this.provider = provider;
    this.kind = kind;
    if (options?.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }

  /** True when the same request may succeed later or on another provider. */
  get retryable(): boolean {
    return RETRYABLE.has(this.kind);
  }
}
