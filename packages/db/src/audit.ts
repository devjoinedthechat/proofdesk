import { type Kysely, sql } from "kysely";
import type { AppDatabase } from "./schema.ts";

export type AuditEntry = {
  tenantId: string;
  ticketId?: string;
  at: Date;
  /** Who acted: the agent, a member of staff, or the system. */
  actor: string;
  /** What happened, such as `tool_call` or `approval_decided`. */
  event: string;
  /** Identifiers and amounts only. Never ticket text or personal data. */
  detail: Record<string, unknown>;
};

/** Appends one entry to the hash-chained audit log and returns its sequence number. */
export async function appendAudit(db: Kysely<AppDatabase>, entry: AuditEntry): Promise<number> {
  const result = await sql<{ seq: number }>`
    select audit_append(
      ${entry.tenantId}, ${entry.ticketId ?? null}, ${entry.at},
      ${entry.actor}, ${entry.event}, ${JSON.stringify(entry.detail)}
    ) as seq
  `.execute(db);
  const seq = result.rows[0]?.seq;
  if (seq === undefined) throw new Error("The audit log did not return a sequence number");
  return seq;
}

export type AuditHead = { seq: number; hash: string };

/** The newest entry's position and hash. Store it somewhere the database owner cannot reach. */
export async function auditHead(db: Kysely<AppDatabase>): Promise<AuditHead | null> {
  const row = await db
    .selectFrom("auditLog")
    .select(["seq", "hash"])
    .orderBy("seq", "desc")
    .limit(1)
    .executeTakeFirst();
  return row ?? null;
}

/**
 * Verifies the chain and returns every problem found. An edited or removed
 * entry breaks the chain from that point on. Removing the newest entries
 * leaves a shorter but intact chain, so that case is only caught by comparing
 * against a head recorded earlier: pass it as `expectedHead`.
 */
export async function verifyAudit(
  db: Kysely<AppDatabase>,
  options: { expectedHead?: AuditHead } = {},
): Promise<{ seq: number; problem: string }[]> {
  const result = await sql<{ seq: number; problem: string }>`select * from audit_verify()`.execute(
    db,
  );
  const problems = [...result.rows];

  if (options.expectedHead) {
    const { seq, hash } = options.expectedHead;
    const row = await db
      .selectFrom("auditLog")
      .select("hash")
      .where("seq", "=", seq)
      .executeTakeFirst();
    if (row?.hash !== hash) {
      problems.push({ seq, problem: "the entry recorded as the head is gone or different" });
    }
  }
  return problems;
}
