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

describe("the spend ledger", () => {
  it("lets in only as many simultaneous reservations as the budget has room for", async () => {
    const ledger = createDbLedger(db);
    const tenant = { key: "tenant:crowded", limitMicros: 300 };

    // Twenty workers each set 100 aside at the same moment, each for its
    // own ticket and all for one company. The company has room for three.
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, n) =>
        ledger.reserve([{ key: `ticket:crowded:${n}`, limitMicros: 1000 }, tenant], 100),
      ),
    );

    expect(results.filter((result) => result === null)).toHaveLength(3);
    expect(results.filter((result) => result?.key === tenant.key)).toHaveLength(17);
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
    );

    expect(refused).toEqual({ key: "ticket:full:1", spentMicros: 50 });
    expect(await ledger.spent("tenant:full")).toBe(0);
  }, 60_000);

  it("replaces a reservation with what the call cost", async () => {
    const ledger = createDbLedger(db);
    const hold = { key: "tenant:settled", limitMicros: 1000 };
    await ledger.reserve([hold], 400);
    await ledger.add(hold.key, 120 - 400);
    expect(await ledger.spent(hold.key)).toBe(120);
  }, 60_000);
});
