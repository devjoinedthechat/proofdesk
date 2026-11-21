/**
 * One test, named by its file and the exact title of its `it`. A title with a
 * placeholder, from `it.each`, stands for every case made from it.
 */
export type TestRef = { file: string; name: string };

/**
 * A control taken out of the source, to show that the tests notice. The edit
 * is applied to the working tree, the tests are run, and the file is put back.
 */
export type Removal = {
  /** What is taken out, in a few words, for the claims table. */
  what: string;
  /** The file the control lives in, from the repository root. */
  file: string;
  /**
   * The exact text that is the control. It must occur in the file once, so a
   * control that is rewritten or moved fails the check instead of quietly
   * going unproven. Left out, the whole file is deleted.
   */
  find?: string;
  /** What stands in its place. Nothing, unless the code has to keep its shape. */
  replace?: string;
  /** The tests that must fail. Left out: every test of the claim. */
  fails?: TestRef[];
};

export const SECTIONS = [
  "Identity and authority",
  "Policy and guardrails",
  "Durable execution",
  "Conversation",
  "Retrieval and memory",
  "Operations",
  "Data deletion",
] as const;

export type Section = (typeof SECTIONS)[number];

/**
 * One property the repository claims, the tests that attack it, and what
 * happens to those tests when the control behind it is removed.
 */
export type Claim = {
  /** Stable and short: `pnpm prove <id>` runs one claim. */
  id: string;
  section: Section;
  property: string;
  /** How the tests try to break it. */
  attack: string;
  tests: TestRef[];
  /**
   * Evidence that is not a unit or integration test: a measurement on a real
   * model, or the script that starts the whole system. A claim may rest on
   * this alone, and then nothing can be removed to check it.
   */
  evidence?: { label: string; path: string };
  /** Shown in the README's short table as well as in the full one. */
  headline?: boolean;
} & (
  | { removals: Removal[] }
  /**
   * Why no single edit removes the control. A claim must say one or the
   * other: there is no silent third state.
   */
  | { noRemoval: string }
);
