import { CamelCasePlugin, Kysely, PostgresDialect } from "kysely";
import pg from "pg";

// Postgres returns bigint (count, sum) as a string by default. Every amount in
// this system fits a JavaScript safe integer, so parse them as numbers.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));

/** Opens a pool. Columns are snake_case in SQL and camelCase in TypeScript. */
export function connect<Schema>(url: string, options: { maxConnections?: number } = {}) {
  const pool = new pg.Pool({ connectionString: url, max: options.maxConnections ?? 5 });
  // An idle connection that the server closes (a restart, a dropped database)
  // reports it here. The pool has already discarded it; without a listener
  // the event would end the process.
  pool.on("error", (error) => {
    console.warn(`An idle database connection was closed: ${error.message}`);
  });
  return new Kysely<Schema>({
    dialect: new PostgresDialect({ pool }),
    plugins: [new CamelCasePlugin()],
  });
}
