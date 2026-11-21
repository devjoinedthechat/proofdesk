import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLAIMS } from "./claims.ts";
import { renderClaims, withHeadlines } from "./render.ts";
import { problems, ROOT } from "./source.ts";

// Rewrites docs/claims.md and the README's short table from the claims.

const broken = problems(CLAIMS);
if (broken.length > 0) {
  console.error(`The claims do not match the source:\n  ${broken.join("\n  ")}`);
  process.exit(1);
}

const readme = join(ROOT, "README.md");
writeFileSync(join(ROOT, "docs/claims.md"), renderClaims(CLAIMS));
writeFileSync(readme, withHeadlines(readFileSync(readme, "utf8"), CLAIMS));
console.log("Wrote docs/claims.md and the claims table in README.md.");
