import {
  type AppDatabase,
  asRole,
  connect,
  DB_ROLES,
  TEST_ROLE_PASSWORD,
  testPostgresUrl,
} from "@proofdesk/db";
import { createSimEnv, type SimEnv } from "@proofdesk/simulator";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbLedger } from "./ledger.ts";

// The spend ledger on a real Postgres, as the worker's own role. What
// matters is what happens when reservations arrive together, which no
// in-memory stand-in can show.

let env: SimEnv;
let db: Kysely<AppDatabase>;

beforeAll(async () => {
  env = await createSimEnv(testPostgresUrl());
  db = connect<AppDatabase>(asRole(env.urls.app, DB_ROLES.worker, TEST_ROLE_PASSWORD), {
    maxConnections: 10,
  });
}, 300_000);

afterAll(async () => {
  await db?.destroy();
  await env?.dispose();
});

const TTL = 60_000;

describe("the spend ledger", () => {
  it("lets in only as many simultaneous reservations as the budget has room for", async () => {
    const ledger = createDbLedger(db);
    const tenant = { key: "tenant:crowded", limitMicros: 300 };

    // Twenty workers each set 100 aside at the same moment, each for its
    // own ticket and all for one company. The company has room for three.
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, n) =>
        ledger.reserve([{ key: `ticket:crowded:${n}`, limitMicros: 1000 }, tenant], 100, TTL),
      ),
    );

    expect(results.filter((result) => "reservation" in result)).toHaveLength(3);
    expect(
      results.filter((result) => "full" in result && result.full.key === tenant.key),
    ).toHaveLength(17);
    expect(await ledger.spent(tenant.key)).toBe(300);
  }, 60_000);

  it("sets nothing aside anywhere when one of the budgets is used up", async () => {
    const ledger = createDbLedger(db);
    await ledger.add("ticket:full:1", 50);

    const refused = await ledger.reserve(
      [
        { key: "ticket:full:1", limitMicros: 50 },
        { key: "tenant:full", limitMicros: 1000 },
      ],
      10,
      TTL,
    );

    expect(refused).toEqual({ full: { key: "ticket:full:1", spentMicros: 50 } });
    expect(await ledger.spent("tenant:full")).toBe(0);
  }, 60_000);

  it("replaces a reservation with what the call cost", async () => {
    const ledger = createDbLedger(db);
    const hold = { key: "tenant:settled", limitMicros: 1000 };
    const made = await ledger.reserve([hold], 400, TTL);
    if (!("reservation" in made)) throw new Error("The reservation was refused");
    expect(await ledger.spent(hold.key)).toBe(400);

    await ledger.settle(made.reservation, 120);
    expect(await ledger.spent(hold.key)).toBe(120);
  }, 60_000);

  it("gives a budget back what a lost worker had set aside, once the reservation lapses", async () => {
    const ledger = createDbLedger(db);
    const hold = { key: "tenant:lost", limitMicros: 100 };
    // A worker sets the whole budget aside and is never heard from again.
    const lost = await ledger.reserve([hold], 100, 200);
    expect("reservation" in lost).toBe(true);
    expect(await ledger.reserve([hold], 100, TTL)).toEqual({
      full: { key: hold.key, spentMicros: 100 },
    });

    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(await ledger.spent(hold.key)).toBe(0);
    expect("reservation" in (await ledger.reserve([hold], 100, TTL))).toBe(true);
    // The lapsed row is gone, not merely ignored.
    const left = await env.dbs.app
      .selectFrom("spendReservations")
      .select("id")
      .where("key", "=", hold.key)
      .execute();
    expect(left).toHaveLength(1);
  }, 60_000);

  it("still records the cost of a call that outlived its reservation", async () => {
    const ledger = createDbLedger(db);
    const hold = { key: "tenant:slow", limitMicros: 1000 };
    const made = await ledger.reserve([hold], 400, 1);
    if (!("reservation" in made)) throw new Error("The reservation was refused");
    await new Promise((resolve) => setTimeout(resolve, 20));

    await ledger.settle(made.reservation, 250);
    expect(await ledger.spent(hold.key)).toBe(250);
  }, 60_000);
});
