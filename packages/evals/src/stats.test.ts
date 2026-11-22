import { describe, expect, it } from "vitest";
import { binomialCdf, pairedSignTest, rateInterval, upperBound } from "./stats.ts";

describe("rate intervals", () => {
  it("match published exact intervals", () => {
    // 5 of 10: the textbook Clopper-Pearson interval is 0.187 to 0.813.
    const [lo, hi] = rateInterval(5, 10);
    expect(lo).toBeCloseTo(0.187, 3);
    expect(hi).toBeCloseTo(0.813, 3);
  });

  it("are closed at the end the result sits on", () => {
    expect(rateInterval(0, 20)[0]).toBe(0);
    expect(rateInterval(20, 20)[1]).toBe(1);
    // All of n: the lower end is (alpha/2)^(1/n).
    expect(rateInterval(96, 96)[0]).toBeCloseTo(0.025 ** (1 / 96), 6);
  });

  it("say what none in n can rule out", () => {
    // One-sided 95%: 1 - 0.05^(1/n), close to the rule of three, 3/n.
    expect(upperBound(0, 93)).toBeCloseTo(1 - 0.05 ** (1 / 93), 6);
    expect(upperBound(0, 93)).toBeCloseTo(0.0317, 3);
    expect(upperBound(0, 31)).toBeCloseTo(0.092, 3);
  });

  it("rest on a binomial distribution that sums to one", () => {
    expect(binomialCdf(12, 12, 0.3)).toBeCloseTo(1, 10);
    expect(binomialCdf(0, 3, 0.5)).toBeCloseTo(0.125, 10);
  });
});

describe("the paired sign test", () => {
  it("counts each scenario once and ignores the ones both got the same", () => {
    const first = new Map([
      ["a", 1],
      ["b", 1],
      ["c", 2 / 3],
      ["d", 1],
    ]);
    const second = new Map([
      ["a", 1],
      ["b", 0],
      ["c", 2 / 3],
      ["d", 1 / 3],
      ["e", 0],
    ]);
    expect(pairedSignTest(first, second)).toMatchObject({ first: 2, second: 0, ties: 2 });
    // Two of two going one way is not evidence: p = 0.5.
    expect(pairedSignTest(first, second).p).toBeCloseTo(0.5, 10);
  });

  it("finds a difference that holds across many scenarios", () => {
    const first = new Map(Array.from({ length: 10 }, (_, i) => [`s${i}`, 1]));
    const second = new Map(Array.from({ length: 10 }, (_, i) => [`s${i}`, 0]));
    expect(pairedSignTest(first, second).p).toBeCloseTo(2 / 1024, 10);
  });
});
