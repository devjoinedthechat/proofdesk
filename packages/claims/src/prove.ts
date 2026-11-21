import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Started, startKeycloak, startTemporal } from "../../../test/containers.ts";
import { CLAIMS } from "./claims.ts";
import { expectedFailures, problems, ROOT, titleMatches, withoutControl } from "./source.ts";
import type { Claim, Removal, TestRef } from "./types.ts";

// Read by test/global-setup.ts, which then starts neither server itself.
const KEYCLOAK_ENV = "PROOFDESK_TEST_KEYCLOAK_URL";
const TEMPORAL_ENV = "PROOFDESK_TEST_TEMPORAL_ADDRESS";

type Job = { claim: Claim; removal: Removal; fails: TestRef[] };

type Verdict =
  /** Every named test ran and failed: the tests notice the control is gone. */
  | { kind: "red"; because: string }
  /** A named test still passed. The claim is not backed by it. */
  | { kind: "green"; tests: TestRef[] }
  /** A named test did not run, so nothing was learned. */
  | { kind: "not_run"; tests: TestRef[]; output: string };

/** What Vitest's JSON reporter writes, as far as it is read here. */
type Report = {
  testResults: {
    name: string;
    assertionResults: { title: string; status: string; failureMessages?: string[] }[];
  }[];
};

function usage(): never {
  console.error(
    [
      "Usage: pnpm prove [claim ...] [--list] [--shard <index>/<count>]",
      "",
      "Removes each control in turn and expects the tests behind its claim to fail.",
    ].join("\n"),
  );
  process.exit(2);
}

function parse(argv: string[]) {
  const ids: string[] = [];
  let list = false;
  let shard: { index: number; count: number } | undefined;
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at] ?? "";
    if (arg === "--list") list = true;
    else if (arg === "--shard") {
      const match = /^(\d+)\/(\d+)$/.exec(argv[++at] ?? "");
      const index = Number(match?.[1]);
      const count = Number(match?.[2]);
      if (!match || index < 1 || index > count) usage();
      shard = { index, count };
    } else if (arg.startsWith("-")) usage();
    else ids.push(arg);
  }
  return { ids, list, shard };
}

/** The file as it was, held in memory, and the way to put it back. */
function apply(removal: Removal): () => void {
  const path = join(ROOT, removal.file);
  const original = readFileSync(path);
  const changed = withoutControl(removal);
  if (changed === null) rmSync(path);
  else writeFileSync(path, changed);
  return () => writeFileSync(path, original);
}

function runTests(files: string[], reportPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      join(ROOT, "node_modules/.bin/vitest"),
      ["run", ...files, "--reporter=json", `--outputFile=${reportPath}`],
      { cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", reject);
    // The exit code says only that something failed. Which test, and whether
    // it ran at all, is read from the report.
    child.on("close", () => resolve(output));
  });
}

function judge(fails: TestRef[], report: Report | undefined, output: string): Verdict {
  // One name can stand for several cases of an `it.each`. It counts as failed
  // when any case failed, and as not run when no case was reported at all.
  const results = (test: TestRef) =>
    report?.testResults
      .find((result) => result.name === join(ROOT, test.file))
      ?.assertionResults.filter((result) => titleMatches(test.name, result.title)) ?? [];
  const failed = (test: TestRef) => results(test).find((result) => result.status === "failed");
  const green = fails.filter(
    (test) => !failed(test) && results(test).some((result) => result.status === "passed"),
  );
  if (green.length > 0) return { kind: "green", tests: green };
  const notRun = fails.filter((test) => !failed(test));
  if (notRun.length > 0) return { kind: "not_run", tests: notRun, output };
  const first = fails[0] && failed(fails[0])?.failureMessages?.[0];
  return { kind: "red", because: (first ?? "").split("\n")[0]?.slice(0, 160) ?? "" };
}

const name = (job: Job) => `${job.claim.id}: ${job.removal.what}`;

async function main() {
  const options = parse(process.argv.slice(2));

  const broken = problems(CLAIMS);
  if (broken.length > 0) {
    console.error(`The claims do not match the source:\n  ${broken.join("\n  ")}`);
    process.exit(1);
  }
  const unknown = options.ids.filter((id) => !CLAIMS.some((claim) => claim.id === id));
  if (unknown.length > 0) {
    console.error(`No such claim: ${unknown.join(", ")}`);
    process.exit(2);
  }

  let jobs: Job[] = CLAIMS.filter(
    (claim) => options.ids.length === 0 || options.ids.includes(claim.id),
  ).flatMap((claim) =>
    "removals" in claim
      ? claim.removals.map((removal) => ({
          claim,
          removal,
          fails: expectedFailures(claim, removal),
        }))
      : [],
  );
  const { shard } = options;
  if (shard) jobs = jobs.filter((_, at) => at % shard.count === shard.index - 1);

  if (options.list) {
    for (const job of jobs) {
      console.log(`${name(job)}\n    in ${job.removal.file}`);
      for (const test of job.fails) console.log(`    must fail: ${test.file} > ${test.name}`);
    }
    return;
  }
  if (jobs.length === 0) {
    console.log("Nothing to remove.");
    return;
  }

  // Two of the three servers take the longest to start and keep nothing
  // between runs that matters, so they are started once for all removals.
  const servers: Started[] = [];
  let restore: (() => void) | undefined;
  const cleanUp = async () => {
    restore?.();
    restore = undefined;
    await Promise.all(servers.splice(0).map((server) => server.stop().catch(() => {})));
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => void cleanUp().finally(() => process.exit(130)));
  }

  const scratch = mkdtempSync(join(tmpdir(), "proofdesk-prove-"));
  const failures: string[] = [];
  try {
    if (jobs.some((job) => job.fails.some((test) => test.file.endsWith(".itest.ts")))) {
      console.log("Starting Keycloak and Temporal once for every removal...");
      const [keycloak, temporal] = await Promise.all([startKeycloak(), startTemporal()]);
      servers.push(keycloak, temporal);
      process.env[KEYCLOAK_ENV] = keycloak.url;
      process.env[TEMPORAL_ENV] = temporal.url;
    }

    for (const [at, job] of jobs.entries()) {
      const started = Date.now();
      const reportPath = join(scratch, `${at}.json`);
      const files = [...new Set(job.fails.map((test) => test.file))];
      restore = apply(job.removal);
      let output: string;
      try {
        output = await runTests(files, reportPath);
      } finally {
        restore();
        restore = undefined;
      }
      const report = existsSync(reportPath)
        ? (JSON.parse(readFileSync(reportPath, "utf8")) as Report)
        : undefined;
      const verdict = judge(job.fails, report, output);
      const seconds = ((Date.now() - started) / 1000).toFixed(0);
      const label = `[${at + 1}/${jobs.length}] ${name(job)} (${seconds}s)`;

      if (verdict.kind === "red") {
        console.log(`red    ${label}\n         ${verdict.because}`);
        continue;
      }
      const which = verdict.tests.map((test) => `${test.file} > ${test.name}`).join("\n         ");
      if (verdict.kind === "green") {
        console.log(`GREEN  ${label}\n       still passes without the control:\n         ${which}`);
      } else {
        console.log(
          `NO RUN ${label}\n       did not run, so nothing was shown:\n         ${which}\n${verdict.output.split("\n").slice(-40).join("\n")}`,
        );
      }
      failures.push(name(job));
    }
  } finally {
    await cleanUp();
    rmSync(scratch, { recursive: true, force: true });
  }

  const red = jobs.length - failures.length;
  console.log(`\n${red} of ${jobs.length} removed controls turned their tests red.`);
  if (failures.length > 0) {
    console.log(`Not shown:\n  ${failures.join("\n  ")}`);
    process.exit(1);
  }
}

await main();
