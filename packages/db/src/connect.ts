import { CamelCasePlugin, Kysely, PostgresDialect } from "kysely";
import pg from "pg";

// Postgres returns bigint (count, sum) as a string by default. Every amount in
// this system fits a JavaScript safe integer, so parse them as numbers.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));

/**
 * Opens a pool. Columns are snake_case in SQL and camelCase in TypeScript.
 *
 * Every connection carries three limits, so that one stuck query, one
 * transaction left open or a database that does not answer cannot hold the
 * pool, and with it the service, for ever.
 */
export function connect<Schema>(
  url: string,
  options: { maxConnections?: number; statementTimeoutMs?: number } = {},
) {
  const pool = new pg.Pool({
    connectionString: url,
    max: options.maxConnections ?? 5,
    connectionTimeoutMillis: 10_000,
    statement_timeout: options.statementTimeoutMs ?? 30_000,
    idle_in_transaction_session_timeout: 60_000,
  });
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
