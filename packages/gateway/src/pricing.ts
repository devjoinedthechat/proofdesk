import type { Usage } from "./types.ts";

/** Prices in US dollars per million tokens. */
export type ModelPrice = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export type PriceTable = Record<string, ModelPrice>;

/**
 * List prices as of October 2026. Check them against the provider's pricing
 * page before relying on a cost figure. Cache writes are taken as 1.25 times
 * the input price, and Haiku's cache read as a tenth of its input price.
 */
export const ANTHROPIC_PRICES: PriceTable = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
};

/**
 * The cost of one call in micro-dollars (millionths of a dollar), as an
 * integer so that sums are exact. Tokens times dollars-per-million-tokens is
 * already micro-dollars.
 */
export function costMicros(price: ModelPrice, usage: Usage): number {
  return Math.ceil(
    usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheReadTokens * price.cacheRead +
      usage.cacheWriteTokens * price.cacheWrite,
  );
}
