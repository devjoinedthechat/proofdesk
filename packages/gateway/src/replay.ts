import { createHash } from "node:crypto";
import { ProviderError } from "./errors.ts";
import type { CallContext, ModelProvider, ModelRequest, ModelResponse } from "./types.ts";

/** Recorded model responses, keyed by a hash of the request that produced them. */
export type Recording = Record<string, ModelResponse>;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, inner]) => [key, canonical(inner)]),
    );
  }
  return value;
}

/** A stable fingerprint of everything in a request that can affect the response. */
export function requestKey(request: ModelRequest): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(request)))
    .digest("hex");
}

/** Passes calls through to a real provider and keeps every response. */
export function createRecordingProvider(inner: ModelProvider, recording: Recording): ModelProvider {
  return {
    name: inner.name,
    async complete(request: ModelRequest, context: CallContext) {
      const response = await inner.complete(request, context);
      recording[requestKey(request)] = response;
      return response;
    },
  };
}

/**
 * Answers from a recording and never calls a model. Pull-request tests use it
 * so they are free and repeatable. A request that was not recorded is an
 * error: it means the prompt, tools or code path changed since the recording,
 * and the test must not pass on a guess.
 */
export function createReplayProvider(recording: Recording, name = "replay"): ModelProvider {
  return {
    name,
    async complete(request: ModelRequest, context: CallContext) {
      context.signal?.throwIfAborted();
      const response = recording[requestKey(request)];
      if (!response) {
        throw new ProviderError(
          name,
          "invalid_request",
          "No recorded response for this request. The prompt, tools or conversation changed since the recording was made; record again.",
        );
      }
      return structuredClone(response);
    },
  };
}
