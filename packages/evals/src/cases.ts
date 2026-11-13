import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ScenarioSpec } from "@proofdesk/simulator";
import { capturedCase, caseToSpec } from "./capture.ts";

export const CASES_DIR = fileURLToPath(new URL("../cases", import.meta.url));

/**
 * The captured cases in the repository, as scenarios. A case that no person
 * has read is refused, loudly: it should never have been committed.
 */
export function loadCapturedCases(directory: string = CASES_DIR): ScenarioSpec[] {
  return readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) =>
      caseToSpec(capturedCase.parse(JSON.parse(readFileSync(`${directory}/${file}`, "utf8")))),
    );
}
