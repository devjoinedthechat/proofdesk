import { fileURLToPath } from "node:url";

export { createDatabase, databaseUrl, dropDatabase } from "./admin.ts";
export { connect } from "./connect.ts";
export { migrate } from "./migrate.ts";
export type { AppDatabase, CustomerRow, TenantRow, TicketRow, TicketStatus } from "./schema.ts";
export { TEST_POSTGRES_URL_ENV, testPostgresUrl } from "./testing.ts";

/** Migrations for the application database. */
export const APP_MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));
