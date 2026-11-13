import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { type AppDatabase, connect } from "@proofdesk/db";
import { captureCase } from "./capture.ts";
import { CASES_DIR } from "./cases.ts";

// Turns a ticket staff have reviewed into an eval case.
//
//   pnpm evals:capture --ticket tkt_... --database-url postgresql://...
//
// The case is written with "textReviewed": false. Read its subject and body,
// remove anything that says who the customer is, and set it to true. Until
// then the case will not load, and the check that guards commits rejects it.

const { values } = parseArgs({
  options: {
    ticket: { type: "string" },
    "database-url": { type: "string" },
    out: { type: "string" },
  },
});
const url = values["database-url"] ?? process.env.APP_DATABASE_URL;
if (!values.ticket || !url) {
  console.error("--ticket and --database-url (or APP_DATABASE_URL) are required");
  process.exit(2);
}

const db = connect<AppDatabase>(url, { maxConnections: 1 });
try {
  const captured = await captureCase(db, values.ticket);
  const out = values.out ?? `${CASES_DIR}/${captured.id}.json`;
  writeFileSync(out, `${JSON.stringify(captured, null, 2)}\n`);
  console.log(`Wrote ${out}`);
  console.log(
    `The agent ended with ${captured.observed.outcome}; staff expected ${captured.expected.outcome}.`,
  );
  console.log(
    'Next: read the subject and body, remove anything personal, set "textReviewed" to true.',
  );
} finally {
  await db.destroy();
}
