import { basename } from "node:path";
import { type Claim, SECTIONS } from "./types.ts";

/** A Markdown table with its columns padded, the way the rest of the docs are written. */
function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const line = (cells: string[]) =>
    `| ${cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join(" | ")} |`;
  return [line(headers), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)].join(
    "\n",
  );
}

/** Links to the files that hold a claim's tests, each named once. */
function testLinks(claim: Claim, prefix: string): string {
  const files = [...new Set(claim.tests.map((test) => test.file))];
  const links = files.map((file) => `[${basename(file)}](${prefix}${file})`);
  if (claim.evidence) links.push(`[${claim.evidence.label}](${prefix}${claim.evidence.path})`);
  return links.join(", ");
}

function removed(claim: Claim): string {
  if ("noRemoval" in claim) return `None. ${claim.noRemoval}`;
  return claim.removals.map((removal) => removal.what).join("; ");
}

export function counts(claims: Claim[]) {
  const proven = claims.filter((claim) => "removals" in claim);
  return {
    claims: claims.length,
    proven: proven.length,
    removals: proven.reduce(
      (sum, claim) => sum + ("removals" in claim ? claim.removals.length : 0),
      0,
    ),
    tests: new Set(claims.flatMap((claim) => claim.tests.map((t) => `${t.file}\0${t.name}`))).size,
  };
}

/** `docs/claims.md`, whole. */
export function renderClaims(claims: Claim[]): string {
  const n = counts(claims);
  const parts = [
    "# Claims",
    "",
    "<!-- Generated from packages/claims/src/claims.ts by `pnpm claims:write`. Edit that file, not this one. -->",
    "",
    `Every property this repository claims, the tests that attack it, and the control that was taken out to check that those tests notice. ${n.claims} properties, ${n.tests} tests, ${n.removals} controls removed.`,
    "",
    "## How to read it",
    "",
    "- **Property.** What is claimed, with the id that `pnpm prove` takes.",
    "- **How the test tries to break it.** The attack, not the happy path.",
    "- **Tests.** The files that hold them. The exact test names are in [claims.ts](../packages/claims/src/claims.ts).",
    "- **Control removed.** One edit to the source that takes the control out. With it applied, the tests must fail.",
    "",
    "## How it is checked",
    "",
    "```sh",
    "pnpm prove                 # remove each control in turn and expect its tests to fail",
    "pnpm prove refund-once     # one claim",
    "pnpm prove --list          # what would be removed, without running anything",
    "```",
    "",
    "- **A removal that leaves its tests green fails the command.** So does one that stops the tests from running at all: a red suite is not evidence unless the named test ran and failed.",
    "- **The claims cannot go stale quietly.** A unit test fails when a named test no longer exists, when a control's text is no longer in the source exactly once, or when this page differs from what the claims generate.",
    "- **CI runs every removal on every push.** The removals are edits to the working tree, made and undone by the command. No switch in the shipped code turns a control off.",
    "- **Some properties have no single control.** They are the result of how a part is built, or of a setting outside this code. Those say so, and are covered by their tests alone.",
  ];
  for (const section of SECTIONS) {
    const rows = claims
      .filter((claim) => claim.section === section)
      .map((claim) => [
        `${claim.property}<br>\`${claim.id}\``,
        claim.attack,
        testLinks(claim, "../"),
        removed(claim),
      ]);
    if (rows.length === 0) continue;
    parts.push(
      "",
      `## ${section}`,
      "",
      table(["Property", "How the test tries to break it", "Tests", "Control removed"], rows),
    );
  }
  return `${parts.join("\n")}\n`;
}

export const README_START = "<!-- claims:start -->";
export const README_END = "<!-- claims:end -->";

/** The short table in the README: the headline claims, one per row. */
export function renderHeadlines(claims: Claim[]): string {
  const n = counts(claims);
  const rows = claims
    .filter((claim) => claim.headline)
    .map((claim) => [claim.property, claim.attack, testLinks(claim, "")]);
  return [
    README_START,
    table(["Property", "How the test tries to break it", "Test"], rows),
    "",
    `These are ${rows.length} of ${n.claims}. [The full list](docs/claims.md) names the tests behind each one and the control that was removed to check them.`,
    README_END,
  ].join("\n");
}

/** A document with the generated block between the markers replaced. */
export function withHeadlines(readme: string, claims: Claim[]): string {
  const start = readme.indexOf(README_START);
  const end = readme.indexOf(README_END);
  if (start < 0 || end < start) throw new Error("The README has no claims block");
  return readme.slice(0, start) + renderHeadlines(claims) + readme.slice(end + README_END.length);
}
