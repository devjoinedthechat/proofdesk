import { fileURLToPath } from "node:url";

export { createDatabase, databaseUrl, dropDatabase, ensureRoles } from "./admin.ts";
export { type AuditEntry, type AuditHead, appendAudit, auditHead, verifyAudit } from "./audit.ts";
export { connect } from "./connect.ts";
export { migrate } from "./migrate.ts";
export type {
  AgentRunRow,
  AppDatabase,
  ApprovalRow,
  ApprovalStatus,
  AuditLogRow,
  CustomerRow,
  GrantAssertionRow,
  TenantRow,
  TicketCategory,
  TicketGrantRow,
  TicketRow,
  TicketStatus,
} from "./schema.ts";
export { asRole, DB_ROLES, type RowScope, withRowScope } from "./scope.ts";
export { TEST_POSTGRES_URL_ENV, TEST_ROLE_PASSWORD, testPostgresUrl } from "./testing.ts";

/** Migrations for the application database. */
export const APP_MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));
