import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveBinary } from "dbmate";

const run = promisify(execFile);

/** Applies every pending migration in `migrationsDir` to the database at `url`. */
export async function migrate(url: string, migrationsDir: string): Promise<void> {
  const target = new URL(url);
  if (!target.searchParams.has("sslmode")) target.searchParams.set("sslmode", "disable");

  await run(resolveBinary(), [
    "--url",
    target.toString(),
    "--migrations-dir",
    migrationsDir,
    "--no-dump-schema",
    "up",
  ]);
}
