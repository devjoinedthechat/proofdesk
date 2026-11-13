import { CamelCasePlugin, Kysely, PostgresDialect } from "kysely";
import pg from "pg";

// Postgres returns bigint (count, sum) as a string by default. Every amount in
// this system fits a JavaScript safe integer, so parse them as numbers.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));

/** Opens a pool. Columns are snake_case in SQL and camelCase in TypeScript. */
export function connect<Schema>(url: string, options: { maxConnections?: number } = {}) {
  const pool = new pg.Pool({ connectionString: url, max: options.maxConnections ?? 5 });
  return new Kysely<Schema>({
    dialect: new PostgresDialect({ pool }),
    plugins: [new CamelCasePlugin()],
  });
}
