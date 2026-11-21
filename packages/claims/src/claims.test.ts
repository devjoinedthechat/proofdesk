import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLAIMS } from "./claims.ts";
import { renderClaims, withHeadlines } from "./render.ts";
import { problems, ROOT, titleMatches, withoutControl } from "./source.ts";
import type { Claim } from "./types.ts";

const read = (file: string) => readFileSync(join(ROOT, file), "utf8");

describe("the claims", () => {
  it("name tests that exist and controls that are in the source exactly once", () => {
    expect(problems(CLAIMS)).toEqual([]);
  });

  it("each say how the control is removed, or why it cannot be", () => {
    for (const claim of CLAIMS) {
      expect("removals" in claim || "noRemoval" in claim, claim.id).toBe(true);
    }
  });

  it("are what docs/claims.md says, word for word", () => {
    expect(read("docs/claims.md"), "run pnpm claims:write").toBe(renderClaims(CLAIMS));
  });

  it("are what the README's table says", () => {
    const readme = read("README.md");
    expect(withHeadlines(readme, CLAIMS), "run pnpm claims:write").toBe(readme);
  });
});

describe("the check on the claims", () => {
  const claim: Claim = {
    id: "example",
    section: "Operations",
    property: "A property",
    attack: "An attack",
    tests: [{ file: "packages/claims/src/claims.test.ts", name: "notices a test that is gone" }],
    removals: [
      {
        what: "A control",
        file: "packages/claims/src/source.ts",
        find: "export function problems(claims: Claim[]): string[] {",
      },
    ],
  };

  it("passes a claim whose test and control are both there", () => {
    expect(problems([claim])).toEqual([]);
  });

  it("notices a test that is gone", () => {
    const renamed = {
      ...claim,
      tests: [{ file: claim.tests[0]?.file ?? "", name: "was renamed" }],
    };
    expect(problems([renamed])).toEqual([
      'example: no test "was renamed" in packages/claims/src/claims.test.ts',
      'example (A control): no test "was renamed" in packages/claims/src/claims.test.ts',
    ]);
  });

  it("notices a control whose text is no longer in the source, or is there twice", () => {
    const gone = { ...claim, removals: [{ ...claim.removals[0], find: "no such line of code" }] };
    expect(problems([gone as Claim])).toEqual([
      "example (A control): the control's text occurs 0 times in packages/claims/src/source.ts, not once",
    ]);
    const twice = { ...claim, removals: [{ ...claim.removals[0], find: "found.push(" }] };
    expect(problems([twice as Claim])[0]).toMatch(/occurs \d+ times/);
  });

  it("refuses a removal that edits a test, an id used twice, and a claim with nothing behind it", () => {
    const editsTest = {
      ...claim,
      removals: [{ what: "A test", file: "packages/claims/src/claims.test.ts" }],
    };
    expect(problems([editsTest])).toContain("example (A test): removes part of a test");
    expect(problems([claim, claim])).toContain("example: used by more than one claim");
    expect(problems([{ ...claim, tests: [], noRemoval: "none" } as Claim])).toContain(
      "example: names no test",
    );
  });

  it("takes the control out of the file's text and leaves the rest", () => {
    const removal = claim.removals[0];
    const without = removal ? withoutControl({ ...removal, replace: "// gone" }) : null;
    expect(without).toContain("// gone");
    expect(without).not.toContain("export function problems(");
    expect(without).toContain("export function withoutControl(");
  });

  it("matches every case of an it.each by its title's placeholder, and nothing else", () => {
    expect(titleMatches("refuses %s (twice)", "refuses a refund (twice)")).toBe(true);
    expect(titleMatches("refuses %s (twice)", "refuses a refund")).toBe(false);
    expect(titleMatches("plain title", "plain title")).toBe(true);
    expect(titleMatches("plain title", "plain title, longer")).toBe(false);
  });
});
