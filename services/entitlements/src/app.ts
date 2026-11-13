import {
  type Authenticate,
  assertCustomerAccess,
  createServiceApp,
  HttpError,
  parseBody,
} from "@proofdesk/service";
import type { Kysely } from "kysely";
import { type Entitlement, setEntitlementRequest } from "./api.ts";
import type { EntitlementRow, EntitlementsDatabase } from "./schema.ts";

export type EntitlementsDeps = {
  db: Kysely<EntitlementsDatabase>;
  clock: () => Date;
};

function toEntitlement(row: EntitlementRow): Entitlement {
  return {
    customerId: row.customerId,
    planCode: row.planCode,
    seats: row.seats,
    status: row.status,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function createEntitlementsApp(deps: EntitlementsDeps & { authenticate: Authenticate }) {
  const app = createServiceApp(deps.authenticate);

  app.get("/customers/:customerId/entitlement", async (c) => {
    const principal = c.get("principal");
    const customerId = c.req.param("customerId");
    assertCustomerAccess(principal, customerId);

    const row = await deps.db
      .selectFrom("entitlements")
      .selectAll()
      .where("tenantId", "=", principal.tenantId)
      .where("customerId", "=", customerId)
      .executeTakeFirst();
    if (!row) throw new HttpError(404, "entitlement_not_found", "Entitlement not found");
    return c.json({ entitlement: toEntitlement(row) });
  });

  app.put("/customers/:customerId/entitlement", async (c) => {
    const principal = c.get("principal");
    const customerId = c.req.param("customerId");
    assertCustomerAccess(principal, customerId);
    const request = await parseBody(c.req.raw, setEntitlementRequest);

    // One statement: the version check and the write cannot be separated.
    const row = await deps.db
      .updateTable("entitlements")
      .set({
        planCode: request.planCode,
        seats: request.seats,
        version: request.expectedVersion + 1,
        updatedAt: deps.clock(),
        updatedBy: principal.subject,
      })
      .where("tenantId", "=", principal.tenantId)
      .where("customerId", "=", customerId)
      .where("version", "=", request.expectedVersion)
      .returningAll()
      .executeTakeFirst();
    if (row) return c.json({ entitlement: toEntitlement(row) });

    const current = await deps.db
      .selectFrom("entitlements")
      .select("version")
      .where("tenantId", "=", principal.tenantId)
      .where("customerId", "=", customerId)
      .executeTakeFirst();
    if (!current) throw new HttpError(404, "entitlement_not_found", "Entitlement not found");
    throw new HttpError(
      409,
      "version_conflict",
      `Expected version ${request.expectedVersion}, but the entitlement is at version ${current.version}`,
    );
  });

  return app;
}
