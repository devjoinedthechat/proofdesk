import type { Databases } from "./load.ts";

type Row = Record<string, unknown>;

/** Every row of every table, keyed `database.table`, in a stable order. */
export type Snapshot = Record<string, Row[]>;

export type Change = {
  table: string;
  kind: "added" | "removed" | "changed";
  row: Row;
};

function keyOf(table: string, row: Row): string {
  if (table === "entitlements.entitlements") return `${row.tenantId}/${row.customerId}`;
  return String(row.id);
}

function normalise(row: Row): Row {
  const result: Row = {};
  for (const [key, value] of Object.entries(row)) {
    result[key] = value instanceof Date ? value.toISOString() : value;
  }
  return result;
}

/** Reads the whole simulated company. This is what "final state" means in a scenario. */
export async function takeSnapshot(dbs: Databases): Promise<Snapshot> {
  const tables: Record<string, Promise<Row[]>> = {
    "app.tenants": dbs.app.selectFrom("tenants").selectAll().execute(),
    "app.customers": dbs.app.selectFrom("customers").selectAll().execute(),
    "app.tickets": dbs.app.selectFrom("tickets").selectAll().execute(),
    "billing.plans": dbs.billing.selectFrom("plans").selectAll().execute(),
    "billing.subscriptions": dbs.billing.selectFrom("subscriptions").selectAll().execute(),
    "billing.invoices": dbs.billing.selectFrom("invoices").selectAll().execute(),
    "billing.payments": dbs.billing.selectFrom("payments").selectAll().execute(),
    "billing.refunds": dbs.billing.selectFrom("refunds").selectAll().execute(),
    "entitlements.entitlements": dbs.entitlements.selectFrom("entitlements").selectAll().execute(),
  };

  const snapshot: Snapshot = {};
  for (const [table, query] of Object.entries(tables)) {
    const rows = (await query).map(normalise);
    rows.sort((a, b) => keyOf(table, a).localeCompare(keyOf(table, b)));
    snapshot[table] = rows;
  }
  return snapshot;
}

/** Lists every row that was added, removed or changed between two snapshots. */
export function diffSnapshots(before: Snapshot, after: Snapshot): Change[] {
  const changes: Change[] = [];
  for (const table of Object.keys(after)) {
    const earlier = new Map((before[table] ?? []).map((row) => [keyOf(table, row), row]));
    for (const row of after[table] ?? []) {
      const key = keyOf(table, row);
      const previous = earlier.get(key);
      earlier.delete(key);
      if (!previous) changes.push({ table, kind: "added", row });
      else if (JSON.stringify(previous) !== JSON.stringify(row)) {
        changes.push({ table, kind: "changed", row });
      }
    }
    for (const row of earlier.values()) changes.push({ table, kind: "removed", row });
  }
  return changes;
}
