import { describe, expect, it } from "vitest";
import { routeFor, sampledForReview } from "./app.ts";

const ids = Array.from({ length: 5000 }, (_, index) => `tkt_${index.toString(16)}x${index * 7}`);

describe("routeFor", () => {
  it("sends nothing to the canary at 0 and everything at 100", () => {
    expect(ids.every((id) => routeFor(id, 0) === "stable")).toBe(true);
    expect(ids.every((id) => routeFor(id, 100) === "canary")).toBe(true);
  });

  it("sends about the given share to the canary", () => {
    const share = ids.filter((id) => routeFor(id, 10) === "canary").length / ids.length;
    expect(share).toBeGreaterThan(0.08);
    expect(share).toBeLessThan(0.12);
  });

  it("gives one ticket the same answer every time, and keeps it on the canary as the share grows", () => {
    for (const id of ids.slice(0, 500)) {
      expect(routeFor(id, 25)).toBe(routeFor(id, 25));
      if (routeFor(id, 10) === "canary") expect(routeFor(id, 25)).toBe("canary");
    }
  });
});

describe("sampledForReview", () => {
  it("picks about the given share of tickets, none at 0 and all at 100", () => {
    const share = ids.filter((id) => sampledForReview(id, 10)).length / ids.length;
    expect(share).toBeGreaterThan(0.08);
    expect(share).toBeLessThan(0.12);
    expect(ids.some((id) => sampledForReview(id, 0))).toBe(false);
    expect(ids.every((id) => sampledForReview(id, 100))).toBe(true);
  });

  it("is decided by the ticket alone, and independently of which build handled it", () => {
    expect(sampledForReview("tkt_1", 10)).toBe(sampledForReview("tkt_1", 10));
    // If the sample followed the canary split, a canary would be checked
    // either always or never.
    const canary = ids.filter((id) => routeFor(id, 50) === "canary");
    const sampled = canary.filter((id) => sampledForReview(id, 50)).length / canary.length;
    expect(sampled).toBeGreaterThan(0.4);
    expect(sampled).toBeLessThan(0.6);
  });
});
