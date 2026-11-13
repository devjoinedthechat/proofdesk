import { ProviderError, type ProviderErrorKind } from "./errors.ts";
import { requestKey } from "./replay.ts";
import type { CallContext, ModelProvider, ModelRequest } from "./types.ts";

/**
 * Wraps a provider and makes chosen calls fail the way a provider fails,
 * without the call being made. It exists to test what the gateway and the
 * agent do next, against a real model, without waiting for a real outage.
 */
export function createFaultInjector(
  inner: ModelProvider,
  fails: (request: ModelRequest) => ProviderErrorKind | undefined,
): ModelProvider & { readonly injected: number } {
  let injected = 0;
  return {
    name: inner.name,
    get injected() {
      return injected;
    },
    async complete(request: ModelRequest, context: CallContext) {
      const kind = fails(request);
      if (!kind) return inner.complete(request, context);
      injected += 1;
      throw new ProviderError(inner.name, kind, `Injected fault: ${kind}`);
    },
  };
}

/**
 * A fault rule: one model is overloaded for a share of its calls. The choice
 * is made from the request itself, so every retry of a failing call fails
 * too, as in an outage, and a run with the same seed fails the same calls.
 */
export function modelOutage(options: {
  model: string;
  /** The share of that model's calls that fail, from 0 to 1. */
  rate: number;
  seed?: number;
}): (request: ModelRequest) => ProviderErrorKind | undefined {
  return (request) => {
    if (request.model !== options.model) return undefined;
    const digest = requestKey({ ...request, system: `${options.seed ?? 0}\n${request.system}` });
    return Number.parseInt(digest.slice(0, 8), 16) / 0x1_0000_0000 < options.rate
      ? "overloaded"
      : undefined;
  };
}
