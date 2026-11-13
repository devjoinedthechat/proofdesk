import { fileURLToPath } from "node:url";

export { createDatabase, databaseUrl, dropDatabase, ensureRoles } from "./admin.ts";
export { type AuditEntry, type AuditHead, appendAudit, auditHead, verifyAudit } from "./audit.ts";
export { connect } from "./connect.ts";
export {
  describeMemory,
  MEMORY_LIFETIME_DAYS,
  type Memory,
  purgeExpiredMemories,
  recallMemories,
  rememberTicket,
  type TicketSummary,
} from "./memories.ts";
export { migrate } from "./migrate.ts";
export type {
  AgentRunRow,
  AppDatabase,
  ApprovalRow,
  ApprovalStatus,
  AuditLogRow,
  CustomerRow,
  GrantAssertionRow,
  MemoryRow,
  OutboxKind,
  TenantRow,
  TicketCategory,
  TicketGrantRow,
  TicketMessageRow,
  TicketReviewRow,
  TicketRoute,
  TicketRow,
  TicketStatus,
  TicketTable,
  WorkflowOutboxRow,
} from "./schema.ts";
export { asRole, DB_ROLES, type RowScope, withRowScope } from "./scope.ts";
export { TEST_POSTGRES_URL_ENV, TEST_ROLE_PASSWORD, testPostgresUrl } from "./testing.ts";

/** Migrations for the application database. */
export const APP_MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));
