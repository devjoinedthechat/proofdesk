import type { BillingDatabase } from "@proofdesk/billing";
import type { AppDatabase } from "@proofdesk/db";
import type { EntitlementsDatabase } from "@proofdesk/entitlements";
import type { Kysely } from "kysely";
import type { World } from "./world.ts";

export type Databases = {
  app: Kysely<AppDatabase>;
  billing: Kysely<BillingDatabase>;
  entitlements: Kysely<EntitlementsDatabase>;
};

const CHUNK = 500;

async function insertAll<Row>(rows: Row[], insert: (chunk: Row[]) => Promise<unknown>) {
  for (let start = 0; start < rows.length; start += CHUNK) {
    await insert(rows.slice(start, start + CHUNK));
  }
}

/**
 * Writes a world into the three databases. History is inserted directly, with
 * its past timestamps, because the service APIs only create records "now".
 */
export async function loadWorld(world: World, dbs: Databases): Promise<void> {
  const { app, billing, entitlements } = dbs;

  await insertAll(world.tenants, (rows) => app.insertInto("tenants").values(rows).execute());
  await insertAll(world.customers, (rows) => app.insertInto("customers").values(rows).execute());
  await insertAll(world.tickets, (rows) => app.insertInto("tickets").values(rows).execute());

  await insertAll(world.plans, (rows) => billing.insertInto("plans").values(rows).execute());
  await insertAll(world.subscriptions, (rows) =>
    billing.insertInto("subscriptions").values(rows).execute(),
  );
  await insertAll(world.invoices, (rows) => billing.insertInto("invoices").values(rows).execute());
  await insertAll(world.payments, (rows) => billing.insertInto("payments").values(rows).execute());
  await insertAll(world.refunds, (rows) => billing.insertInto("refunds").values(rows).execute());

  await insertAll(world.entitlements, (rows) =>
    entitlements.insertInto("entitlements").values(rows).execute(),
  );
}
