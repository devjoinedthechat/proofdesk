import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, dropDatabase } from "./admin.ts";
import { appendAudit, auditHead, verifyAudit } from "./audit.ts";
import { connect } from "./connect.ts";
import type { AppDatabase } from "./schema.ts";
import { asRole, DB_ROLES } from "./scope.ts";
import { TEST_ROLE_PASSWORD, testPostgresUrl } from "./testing.ts";

const at = (minute: number) => new Date(Date.UTC(2026, 2, 15, 10, minute));
const entry = (minute: number, event = "tool_call") => ({
  tenantId: "ten_a",
  ticketId: "tkt_1",
  at: at(minute),
  actor: "agent",
  event,
  detail: { tool: "create_refund", amountCents: 87_00, n: minute },
});

/** Owner connection: plays the part of someone with full database access. */
let owner: ReturnType<typeof connect<AppDatabase>>;
/** The worker's connection, which is how entries are written in production. */
let worker: ReturnType<typeof connect<AppDatabase>>;
let database: string;

beforeEach(async () => {
  database = `audit_${Math.random().toString(36).slice(2, 12)}`;
  const url = await createDatabase(testPostgresUrl(), database, { template: "tpl_app" });
  owner = connect<AppDatabase>(url);
  worker = connect<AppDatabase>(asRole(url, DB_ROLES.worker, TEST_ROLE_PASSWORD), {
    maxConnections: 10,
  });
});

afterEach(async () => {
  await worker.destroy();
  await owner.destroy();
  await dropDatabase(testPostgresUrl(), database);
});

describe("audit log", () => {
  it("chains each entry to the one before it", async () => {
    expect(await appendAudit(worker, entry(1))).toBe(1);
    expect(await appendAudit(worker, entry(2))).toBe(2);

    const rows = await owner.selectFrom("auditLog").selectAll().orderBy("seq").execute();
    expect(rows[0]?.prevHash).toBe("0".repeat(64));
    expect(rows[1]?.prevHash).toBe(rows[0]?.hash);
    expect(rows[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyAudit(owner)).toEqual([]);
  });

  it("keeps one unbroken chain under concurrent writers", async () => {
    await Promise.all(Array.from({ length: 30 }, (_, i) => appendAudit(worker, entry(i))));

    const rows = await owner.selectFrom("auditLog").select("seq").orderBy("seq").execute();
    expect(rows.map((row) => Number(row.seq))).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(await verifyAudit(owner)).toEqual([]);
  });

  it("gives the worker no way to read, change or remove entries", async () => {
    await appendAudit(worker, entry(1));

    await expect(worker.selectFrom("auditLog").selectAll().execute()).rejects.toThrow(
      /permission denied/,
    );
    await expect(worker.updateTable("auditLog").set({ detail: "{}" }).execute()).rejects.toThrow(
      /permission denied/,
    );
    await expect(worker.deleteFrom("auditLog").execute()).rejects.toThrow(/permission denied/);
    await expect(
      sql`insert into audit_log values (99, 't', null, now(), 'a', 'e', '{}', 'x', 'y')`.execute(
        worker,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  describe("tampering by someone with full database access", () => {
    beforeEach(async () => {
      for (const minute of [1, 2, 3, 4]) await appendAudit(worker, entry(minute));
    });

    it("detects an edited entry", async () => {
      await owner
        .updateTable("auditLog")
        .set({ detail: JSON.stringify({ tool: "create_refund", amountCents: 1, n: 2 }) })
        .where("seq", "=", 2)
        .execute();

      expect(await verifyAudit(owner)).toEqual([
        { seq: 2, problem: "content does not match its hash" },
      ]);
    });

    it("detects an edited entry even when its own hash is recomputed", async () => {
      await sql`
        update audit_log set actor = 'someone-else',
          hash = audit_entry_hash(prev_hash, seq, tenant_id, ticket_id, at, 'someone-else', event, detail)
        where seq = 2
      `.execute(owner);

      expect(await verifyAudit(owner)).toEqual([
        { seq: 3, problem: "does not link to the previous entry" },
      ]);
    });

    it("detects a removed entry", async () => {
      await owner.deleteFrom("auditLog").where("seq", "=", 2).execute();

      expect(await verifyAudit(owner)).toEqual([
        { seq: 3, problem: "missing entries before this one" },
        { seq: 3, problem: "does not link to the previous entry" },
      ]);
    });

    it("detects removed newest entries only against a recorded head", async () => {
      const head = await auditHead(owner);
      await owner.deleteFrom("auditLog").where("seq", ">=", 3).execute();

      // The shortened chain is intact by itself. This is the limit of a hash
      // chain, and the reason the head must be recorded somewhere else.
      expect(await verifyAudit(owner)).toEqual([]);
      expect(await verifyAudit(owner, { expectedHead: head ?? { seq: 0, hash: "" } })).toEqual([
        { seq: 4, problem: "the entry recorded as the head is gone or different" },
      ]);
    });
  });
});
