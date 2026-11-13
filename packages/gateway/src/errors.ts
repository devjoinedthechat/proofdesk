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

  constructor(provider: string, kind: ProviderErrorKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.provider = provider;
    this.kind = kind;
  }

  /** True when the same request may succeed later or on another provider. */
  get retryable(): boolean {
    return RETRYABLE.has(this.kind);
  }
}
