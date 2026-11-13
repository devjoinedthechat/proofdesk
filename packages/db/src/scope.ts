import { type Kysely, sql, type Transaction } from "kysely";

/** The row-level security roles. Each service connects as its own role, never as the owner. */
export const DB_ROLES = {
  portal: "portal_app",
  grants: "grants_app",
  billing: "billing_app",
  entitlements: "entitlements_app",
} as const;

export type RowScope = {
  tenantId: string;
  /** Limits the transaction to one customer's rows. Omit for tenant-wide access. */
  customerId?: string;
};

/**
 * Runs `fn` in a transaction that can only see the rows of one tenant, and of
 * one customer when given. The limits are set as transaction-local settings
 * that the row-level security policies read. A query that runs outside this
 * helper has no settings and therefore sees no rows at all.
 */
export function withRowScope<Schema, Result>(
  db: Kysely<Schema>,
  scope: RowScope,
  fn: (trx: Transaction<Schema>) => Promise<Result>,
): Promise<Result> {
  return db.transaction().execute(async (trx) => {
    await sql`
      select set_config('app.tenant_id', ${scope.tenantId}, true),
             set_config('app.customer_id', ${scope.customerId ?? "*"}, true)
    `.execute(trx);
    return fn(trx);
  });
}

/** Returns `url` with the credentials of another database role. */
export function asRole(url: string, role: string, password: string): string {
  const result = new URL(url);
  result.username = role;
  result.password = password;
  return result.toString();
}
