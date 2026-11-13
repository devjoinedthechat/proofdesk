import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CASES_DIR, loadCapturedCases } from "./cases.ts";

// Guards what is committed. A captured case comes from a real ticket.
describe("the captured cases in the repository", () => {
  it("have all been read by a person", () => {
    expect(() => loadCapturedCases()).not.toThrow();
  });

  it("hold no email address", () => {
    for (const file of readdirSync(CASES_DIR).filter((name) => name.endsWith(".json"))) {
      expect(readFileSync(`${CASES_DIR}/${file}`, "utf8")).not.toMatch(/[\w.+-]+@[\w-]+\.\w+/);
    }
  });
});
