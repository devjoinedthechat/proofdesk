import { type RowScope, withRowScope } from "@proofdesk/db";
import {
  type Authenticate,
  assertCustomerAccess,
  createServiceApp,
  HttpError,
  type Principal,
  parseBody,
  requireScope,
} from "@proofdesk/service";
import type { Kysely } from "kysely";
import { type Entitlement, setEntitlementRequest } from "./api.ts";
import type { EntitlementRow, EntitlementsDatabase } from "./schema.ts";

export const ENTITLEMENTS_SCOPES = {
  read: "entitlements:read",
  write: "entitlements:write",
  erase: "entitlements:erase",
} as const;

export type EntitlementsDeps = {
  /** A connection as the `entitlements_app` role, which is subject to row-level security. */
  db: Kysely<EntitlementsDatabase>;
  clock: () => Date;
};

function rowScopeOf(principal: Principal): RowScope {
  return principal.customerId === undefined
    ? { tenantId: principal.tenantId }
    : { tenantId: principal.tenantId, customerId: principal.customerId };
}

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
    requireScope(principal, ENTITLEMENTS_SCOPES.read);
    assertCustomerAccess(principal, customerId);

    const row = await withRowScope(deps.db, rowScopeOf(principal), (trx) =>
      trx
        .selectFrom("entitlements")
        .selectAll()
        .where("tenantId", "=", principal.tenantId)
        .where("customerId", "=", customerId)
        .executeTakeFirst(),
    );
    if (!row) throw new HttpError(404, "entitlement_not_found", "Entitlement not found");
    return c.json({ entitlement: toEntitlement(row) });
  });

  app.put("/customers/:customerId/entitlement", async (c) => {
    const principal = c.get("principal");
    const customerId = c.req.param("customerId");
    requireScope(principal, ENTITLEMENTS_SCOPES.write);
    assertCustomerAccess(principal, customerId);
    const request = await parseBody(c.req.raw, setEntitlementRequest);
    const key = c.req.header("idempotency-key");
    if (key === undefined && request.expectedVersion === undefined) {
      throw new HttpError(
        400,
        "version_or_key_required",
        "Send the version you read, or an Idempotency-Key header",
      );
    }
    const fingerprint = JSON.stringify([customerId, request.planCode, request.seats]);

    const entitlement = await withRowScope(deps.db, rowScopeOf(principal), async (trx) => {
      // The row lock makes concurrent writers take turns.
      const current = await trx
        .selectFrom("entitlements")
        .selectAll()
        .where("tenantId", "=", principal.tenantId)
        .where("customerId", "=", customerId)
        .forUpdate()
        .executeTakeFirst();

      if (key !== undefined) {
        const earlier = await trx
          .selectFrom("entitlementWrites")
          .selectAll()
          .where("tenantId", "=", principal.tenantId)
          .where("idempotencyKey", "=", key)
          .executeTakeFirst();
        if (earlier) {
          if (earlier.requestFingerprint !== fingerprint) {
            throw new HttpError(
              409,
              "idempotency_key_reused",
              "This idempotency key was already used for a different write",
            );
          }
          return earlier.result as Entitlement;
        }
      }

      if (!current) throw new HttpError(404, "entitlement_not_found", "Entitlement not found");
      if (current.status !== "active") {
        throw new HttpError(
          422,
          "entitlement_suspended",
          "A suspended entitlement cannot be changed",
        );
      }
      if (request.expectedVersion !== undefined && request.expectedVersion !== current.version) {
        throw new HttpError(
          409,
          "version_conflict",
          `Expected version ${request.expectedVersion}, but the entitlement is at version ${current.version}`,
        );
      }

      const updated: EntitlementRow = {
        ...current,
        planCode: request.planCode,
        seats: request.seats,
        version: current.version + 1,
        updatedAt: deps.clock(),
        updatedBy: principal.subject,
      };
      await trx
        .updateTable("entitlements")
        .set({
          planCode: updated.planCode,
          seats: updated.seats,
          version: updated.version,
          updatedAt: updated.updatedAt,
          updatedBy: updated.updatedBy,
        })
        .where("tenantId", "=", principal.tenantId)
        .where("customerId", "=", customerId)
        .execute();
      const result = toEntitlement(updated);
      if (key !== undefined) {
        await trx
          .insertInto("entitlementWrites")
          .values({
            tenantId: principal.tenantId,
            idempotencyKey: key,
            customerId,
            requestFingerprint: fingerprint,
            result: JSON.stringify(result),
            createdAt: deps.clock(),
          })
          .execute();
      }
      return result;
    });
    return c.json({ entitlement });
  });

  // Removes the customer's access and the record of the writes that set it.
  // Safe to repeat: a second call finds nothing to remove.
  app.delete("/customers/:customerId/entitlement", async (c) => {
    const principal = c.get("principal");
    const customerId = c.req.param("customerId");
    requireScope(principal, ENTITLEMENTS_SCOPES.erase);
    assertCustomerAccess(principal, customerId);

    const erased = await withRowScope(deps.db, rowScopeOf(principal), async (trx) => {
      const writes = await trx
        .deleteFrom("entitlementWrites")
        .where("tenantId", "=", principal.tenantId)
        .where("customerId", "=", customerId)
        .returning("idempotencyKey")
        .execute();
      const entitlements = await trx
        .deleteFrom("entitlements")
        .where("tenantId", "=", principal.tenantId)
        .where("customerId", "=", customerId)
        .returning("customerId")
        .execute();
      return { entitlements: entitlements.length, writes: writes.length };
    });
    return c.json({ erased });
  });

  return app;
}
