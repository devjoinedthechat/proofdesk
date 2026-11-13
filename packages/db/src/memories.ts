import type { Kysely } from "kysely";
import type { AppDatabase } from "./schema.ts";
import { type RowScope, withRowScope } from "./scope.ts";

/** The facts kept about a finished ticket. Nothing here is free text from a person or a model. */
export type TicketSummary = {
  category: string;
  outcome: string;
  reasonCode: string;
  refundedCents: number;
  closedAt: string;
};

export type Memory = {
  id: string;
  sourceTicketId: string;
  content: TicketSummary;
  createdAt: Date;
  expiresAt: Date;
};

const DAY_MS = 86_400_000;
export const MEMORY_LIFETIME_DAYS = 365;

/** Records the summary of a ticket. Writing it again for the same ticket replaces it. */
export async function rememberTicket(
  db: Kysely<AppDatabase>,
  scope: Required<RowScope>,
  input: { id: string; ticketId: string; summary: TicketSummary; now: Date },
): Promise<void> {
  await withRowScope(db, scope, (trx) =>
    trx
      .insertInto("memories")
      .values({
        id: input.id,
        tenantId: scope.tenantId,
        customerId: scope.customerId,
        kind: "ticket_summary",
        sourceTicketId: input.ticketId,
        content: JSON.stringify(input.summary),
        createdAt: input.now,
        expiresAt: new Date(input.now.getTime() + MEMORY_LIFETIME_DAYS * DAY_MS),
      })
      .onConflict((conflict) =>
        conflict.columns(["sourceTicketId", "kind"]).doUpdateSet({
          content: JSON.stringify(input.summary),
          createdAt: input.now,
          expiresAt: new Date(input.now.getTime() + MEMORY_LIFETIME_DAYS * DAY_MS),
        }),
      )
      .execute(),
  );
}

/** A customer's unexpired memories, newest first, leaving out one ticket's own. */
export async function recallMemories(
  db: Kysely<AppDatabase>,
  scope: Required<RowScope>,
  options: { now: Date; excludeTicketId?: string; limit?: number },
): Promise<Memory[]> {
  const rows = await withRowScope(db, scope, (trx) => {
    let query = trx
      .selectFrom("memories")
      .select(["id", "sourceTicketId", "content", "createdAt", "expiresAt"])
      .where("expiresAt", ">", options.now);
    if (options.excludeTicketId)
      query = query.where("sourceTicketId", "!=", options.excludeTicketId);
    return query
      .orderBy("createdAt", "desc")
      .orderBy("id")
      .limit(options.limit ?? 5)
      .execute();
  });
  return rows.map((row) => ({ ...row, content: row.content as TicketSummary }));
}

/** Removes expired memories for every customer. Meant to run on a schedule, as the owner. */
export async function purgeExpiredMemories(db: Kysely<AppDatabase>, now: Date): Promise<number> {
  const deleted = await db
    .deleteFrom("memories")
    .where("expiresAt", "<=", now)
    .returning("id")
    .execute();
  return deleted.length;
}

/** How a memory is shown to the agent: one line, built from the stored facts. */
export function describeMemory(memory: Memory): string {
  const { content } = memory;
  const money =
    content.refundedCents > 0
      ? `${(content.refundedCents / 100).toFixed(2)} refunded`
      : "nothing refunded";
  return `${content.closedAt.slice(0, 10)}: ${content.category} ticket, outcome ${content.outcome} (${content.reasonCode}), ${money}.`;
}
