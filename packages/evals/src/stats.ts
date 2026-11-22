// Small, exact statistics for pass rates. The samples here are small (tens
// of scenarios, a few repeats each), so nothing in this file relies on a
// normal approximation.

/** log(n!) for the binomial coefficients, exact enough for n in the thousands. */
function logFactorial(n: number): number {
  let sum = 0;
  for (let i = 2; i <= n; i++) sum += Math.log(i);
  return sum;
}

function binomialPmf(k: number, n: number, p: number): number {
  if (p <= 0) return k === 0 ? 1 : 0;
  if (p >= 1) return k === n ? 1 : 0;
  return Math.exp(
    logFactorial(n) -
      logFactorial(k) -
      logFactorial(n - k) +
      k * Math.log(p) +
      (n - k) * Math.log(1 - p),
  );
}

/** P(X <= k) for X ~ Binomial(n, p). */
export function binomialCdf(k: number, n: number, p: number): number {
  let sum = 0;
  for (let i = 0; i <= k; i++) sum += binomialPmf(i, n, p);
  return Math.min(1, sum);
}

/** The p in [0, 1] where a decreasing function of p crosses a target. */
function solve(target: number, f: (p: number) => number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * The exact (Clopper-Pearson) two-sided interval for a rate of k in n, at
 * the given confidence. It assumes the n trials are independent.
 */
export function rateInterval(k: number, n: number, confidence = 0.95): [number, number] {
  if (n === 0) return [0, 1];
  const tail = (1 - confidence) / 2;
  const lower = k === 0 ? 0 : solve(1 - tail, (p) => binomialCdf(k - 1, n, p));
  const upper = k === n ? 1 : solve(tail, (p) => binomialCdf(k, n, p));
  return [lower, upper];
}

/**
 * The highest rate that a result of k in n does not rule out, one-sided.
 * For k = 0 this is what "none in n" can honestly claim: at 95%, about 3/n.
 */
export function upperBound(k: number, n: number, confidence = 0.95): number {
  if (n === 0 || k === n) return 1;
  return solve(1 - confidence, (p) => binomialCdf(k, n, p));
}

export type PairedResult = {
  /** Scenarios where the first did better, the second did better, and neither. */
  first: number;
  second: number;
  ties: number;
  /** Two-sided exact sign test on the scenarios where they differ. */
  p: number;
};

/**
 * Compares two runs on the same scenarios. Each scenario counts once, by its
 * pass rate across repeats, so repeats of one ticket do not count as
 * separate evidence.
 */
export function pairedSignTest(
  first: Map<string, number>,
  second: Map<string, number>,
): PairedResult {
  let a = 0;
  let b = 0;
  let ties = 0;
  for (const [id, rate] of first) {
    const other = second.get(id);
    if (other === undefined) continue;
    if (rate > other) a += 1;
    else if (rate < other) b += 1;
    else ties += 1;
  }
  const n = a + b;
  const p = n === 0 ? 1 : Math.min(1, 2 * binomialCdf(Math.min(a, b), n, 0.5));
  return { first: a, second: b, ties, p };
}
