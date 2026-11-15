import { randomUUID } from "node:crypto";
import type { AppDatabase } from "@proofdesk/db";
import type { SpendLedger } from "@proofdesk/gateway";
import { type Kysely, sql, type Transaction } from "kysely";

/**
 * Model spend kept in Postgres, so a budget still holds after the worker
 * restarts. What calls cost is in `spend`; what calls under way have set
 * aside is in `spend_reservations`, where each row expires by itself.
 */
export function createDbLedger(db: Kysely<AppDatabase>): SpendLedger {
  /** What calls under way hold in each budget. Expired rows do not count. */
  async function reserved(trx: Kysely<AppDatabase>, keys: string[]) {
    const rows = await trx
      .selectFrom("spendReservations")
      .select(["key", sql<string>`sum(micros)`.as("micros")])
      .where("key", "in", keys)
      .where("expiresAt", ">", sql<Date>`clock_timestamp()`)
      .groupBy("key")
      .execute();
    return new Map(rows.map((row) => [row.key, Number(row.micros)]));
  }

  const record = (trx: Transaction<AppDatabase>, key: string, micros: number) =>
    trx
      .insertInto("spend")
      .values({ key, micros })
      .onConflict((conflict) =>
        conflict.column("key").doUpdateSet({ micros: sql`spend.micros + excluded.micros` }),
      )
      .execute();

  return {
    async spent(key) {
      const row = await db
        .selectFrom("spend")
        .select("micros")
        .where("key", "=", key)
        .executeTakeFirst();
      return Number(row?.micros ?? 0) + ((await reserved(db, [key])).get(key) ?? 0);
    },
    async reserve(holds, micros, ttlMs) {
      // Always in the same order, so two reservations that share a budget
      // wait for each other instead of each holding what the other needs.
      const keys = holds.map((hold) => hold.key).sort();
      return db.transaction().execute(async (trx) => {
        // A budget nothing was spent from yet has no row to lock.
        await trx
          .insertInto("spend")
          .values(keys.map((key) => ({ key, micros: 0 })))
          .onConflict((conflict) => conflict.column("key").doNothing())
          .execute();
        // The rows stay locked until this transaction ends, which is what
        // makes the look and the write one step.
        const rows = await trx
          .selectFrom("spend")
          .select(["key", "micros"])
          .where("key", "in", keys)
          .orderBy("key")
          .forUpdate()
          .execute();
        // Expired reservations are swept here, whichever budget they were
        // for, so the table does not grow with every worker that was lost.
        // Rows another sweep is already removing are left to it.
        await sql`
          delete from spend_reservations where (id, key) in (
            select id, key from spend_reservations
            where expires_at <= clock_timestamp()
            for update skip locked
          )`.execute(trx);
        const held = await reserved(trx, keys);
        for (const { key, limitMicros } of holds) {
          const spentMicros =
            Number(rows.find((row) => row.key === key)?.micros ?? 0) + (held.get(key) ?? 0);
          if (spentMicros >= limitMicros) return { full: { key, spentMicros } };
        }
        const id = randomUUID();
        await trx
          .insertInto("spendReservations")
          .values(
            keys.map((key) => ({
              id,
              key,
              micros,
              expiresAt: sql<Date>`clock_timestamp() + ${ttlMs} * interval '1 millisecond'`,
            })),
          )
          .execute();
        return { reservation: { id, keys } };
      });
    },
    async settle(reservation, micros) {
      // The cost goes on the books and the reservation comes off them
      // together, so the budget never counts a call twice or not at all.
      await db.transaction().execute(async (trx) => {
        // Budgets are taken in the same order as when reserving.
        if (micros > 0)
          for (const key of [...reservation.keys].sort()) await record(trx, key, micros);
        await trx.deleteFrom("spendReservations").where("id", "=", reservation.id).execute();
      });
    },
    async add(key, micros) {
      await db.transaction().execute((trx) => record(trx, key, micros));
    },
  };
}
