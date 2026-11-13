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
    async add(key, micros) {
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
