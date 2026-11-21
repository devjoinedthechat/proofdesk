import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Claim, Removal, TestRef } from "./types.ts";

/** The repository root. Every path in a claim is counted from here. */
export const ROOT = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");

const read = (file: string) => readFileSync(join(ROOT, file), "utf8");

const TITLE = /^\s*it(?:\.each\([^)]*\))?\(\s*("(?:[^"\\]|\\.)*")/gm;

/** The title of every `it` in a test file, in order. */
export function testTitles(file: string): string[] {
  return [...read(file).matchAll(TITLE)].map((match) => JSON.parse(match[1] ?? '""') as string);
}

function occurrences(text: string, part: string): number {
  let count = 0;
  for (let at = text.indexOf(part); at >= 0; at = text.indexOf(part, at + part.length)) count += 1;
  return count;
}

/**
 * Whether a title in a test report is the named test. A title written for
 * `it.each` has a placeholder where each case puts its own words.
 */
export function titleMatches(name: string, reported: string): boolean {
  if (!name.includes("%")) return name === reported;
  const pattern = name
    .split(/%[sdifjo#]/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${pattern}$`).test(reported);
}

/** The tests a removal must turn red. */
export function expectedFailures(claim: Claim, removal: Removal): TestRef[] {
  return removal.fails ?? claim.tests;
}

/**
 * Everything wrong with the claims as written: a test that no longer exists,
 * a control whose text is no longer in the source, a claim that says neither
 * how its control is removed nor why it cannot be. Checked without running
 * anything, so it is part of the unit tests.
 */
export function problems(claims: Claim[]): string[] {
  const found: string[] = [];
  const titles = new Map<string, string[]>();
  const checkTest = (where: string, test: TestRef) => {
    if (!/\.i?test\.ts$/.test(test.file) || !existsSync(join(ROOT, test.file))) {
      found.push(`${where}: no test file ${test.file}`);
      return;
    }
    if (!titles.has(test.file)) titles.set(test.file, testTitles(test.file));
    const matches = (titles.get(test.file) ?? []).filter((title) => title === test.name).length;
    if (matches === 0) found.push(`${where}: no test "${test.name}" in ${test.file}`);
    if (matches > 1) found.push(`${where}: "${test.name}" names ${matches} tests in ${test.file}`);
  };

  const ids = new Set<string>();
  for (const claim of claims) {
    if (!/^[a-z][a-z0-9-]*$/.test(claim.id)) found.push(`${claim.id}: not a usable id`);
    if (ids.has(claim.id)) found.push(`${claim.id}: used by more than one claim`);
    ids.add(claim.id);
    if (claim.tests.length === 0 && !claim.evidence) found.push(`${claim.id}: names no test`);
    if (claim.evidence && !existsSync(join(ROOT, claim.evidence.path.replace(/#.*$/, "")))) {
      found.push(`${claim.id}: no file ${claim.evidence.path}`);
    }
    for (const test of claim.tests) checkTest(claim.id, test);

    if ("noRemoval" in claim) {
      if (claim.noRemoval.trim() === "") found.push(`${claim.id}: gives no reason for no removal`);
      continue;
    }
    if (claim.removals.length === 0) found.push(`${claim.id}: lists no removal`);
    for (const removal of claim.removals) {
      const where = `${claim.id} (${removal.what})`;
      if (!existsSync(join(ROOT, removal.file))) {
        found.push(`${where}: no file ${removal.file}`);
        continue;
      }
      if (/\.i?test\.ts$/.test(removal.file)) found.push(`${where}: removes part of a test`);
      if (removal.find !== undefined) {
        const count = occurrences(read(removal.file), removal.find);
        if (count !== 1) {
          found.push(
            `${where}: the control's text occurs ${count} times in ${removal.file}, not once`,
          );
        }
        if ((removal.replace ?? "") === removal.find) found.push(`${where}: changes nothing`);
      } else if (removal.replace !== undefined) {
        found.push(`${where}: gives a replacement for a whole file`);
      }
      const fails = expectedFailures(claim, removal);
      if (fails.length === 0) found.push(`${where}: expects no test to fail`);
      for (const test of fails) checkTest(where, test);
    }
  }
  return found;
}

/** The file as it reads with the control taken out, or null when the file is deleted. */
export function withoutControl(removal: Removal): string | null {
  if (removal.find === undefined) return null;
  const text = read(removal.file);
  if (occurrences(text, removal.find) !== 1) {
    throw new Error(`The control's text is not in ${removal.file} exactly once`);
  }
  return text.replace(removal.find, () => removal.replace ?? "");
}
