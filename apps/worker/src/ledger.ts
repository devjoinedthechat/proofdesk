import type { AppDatabase } from "@proofdesk/db";
import type { SpendLedger } from "@proofdesk/gateway";
import { type Kysely, sql } from "kysely";

/** Model spend kept in Postgres, so a budget still holds after the worker restarts. */
export function createDbLedger(db: Kysely<AppDatabase>): SpendLedger {
  return {
    async spent(key) {
      const row = await db
        .selectFrom("spend")
        .select("micros")
        .where("key", "=", key)
        .executeTakeFirst();
      return Number(row?.micros ?? 0);
    },
    async reserve(holds, micros) {
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
        for (const { key, limitMicros } of holds) {
          const spentMicros = Number(rows.find((row) => row.key === key)?.micros ?? 0);
          if (spentMicros >= limitMicros) return { key, spentMicros };
        }
        await trx
          .updateTable("spend")
          .set({ micros: sql`micros + ${micros}` })
          .where("key", "in", keys)
          .execute();
        return null;
      });
    },
    async add(key, micros) {
      if (micros < 0) {
        // Giving part of a reservation back. The row is there, because the
        // reservation made it, and a total never goes below nothing.
        await db
          .updateTable("spend")
          .set({ micros: sql`greatest(micros + ${micros}, 0)` })
          .where("key", "=", key)
          .execute();
        return;
      }
      await db
        .insertInto("spend")
        .values({ key, micros })
        .onConflict((conflict) =>
          conflict.column("key").doUpdateSet({ micros: sql`spend.micros + excluded.micros` }),
        )
        .execute();
    },
  };
}
