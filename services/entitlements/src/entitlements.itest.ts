import { connect, createDatabase, dropDatabase, testPostgresUrl } from "@proofdesk/db";
import { type Principal, ServiceApiError } from "@proofdesk/service";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEntitlementsApp } from "./app.ts";
import { createEntitlementsClient } from "./client.ts";
import type { EntitlementsDatabase } from "./schema.ts";

const NOW = new Date("2026-03-15T10:00:00.000Z");
const HEADER = "x-test-principal";

let db: ReturnType<typeof connect<EntitlementsDatabase>>;
let database: string;
let app: ReturnType<typeof createEntitlementsApp>;

function clientFor(principal: Principal) {
  return createEntitlementsClient({
    baseUrl: "http://entitlements.test",
    fetch: (request) => app.fetch(request),
    headers: () => ({ [HEADER]: JSON.stringify(principal) }),
  });
}

const agentFor = (customerId: string, tenantId = "ten_a"): Principal => ({
  tenantId,
  actor: "agent",
  subject: "agent:test",
  customerId,
});

async function codeOf(promise: Promise<unknown>) {
  return promise.then(
    () => "ok",
    (error: unknown) => (error instanceof ServiceApiError ? error.code : "unexpected"),
  );
}

beforeEach(async () => {
  database = `entitlements_${Math.random().toString(36).slice(2, 12)}`;
  const url = await createDatabase(testPostgresUrl(), database, { template: "tpl_entitlements" });
  db = connect<EntitlementsDatabase>(url, { maxConnections: 10 });
  app = createEntitlementsApp({
    db,
    clock: () => NOW,
    authenticate: (request) => {
      const header = request.headers.get(HEADER);
      return header ? (JSON.parse(header) as Principal) : null;
    },
  });
  await db
    .insertInto("entitlements")
    .values(
      ["ten_a", "ten_b"].map((tenantId) => ({
        tenantId,
        customerId: "cus_1",
        planCode: "starter",
        seats: 2,
        status: "active" as const,
        version: 1,
        updatedAt: NOW,
        updatedBy: "seed",
      })),
    )
    .execute();
});

afterEach(async () => {
  await db.destroy();
  await dropDatabase(testPostgresUrl(), database);
});

describe("entitlements", () => {
  it("reads and updates an entitlement, raising its version", async () => {
    const client = clientFor(agentFor("cus_1"));

    const before = await client.getEntitlement("cus_1");
    const after = await client.setEntitlement("cus_1", {
      planCode: "team",
      seats: 5,
      expectedVersion: before.version,
    });

    expect(before).toMatchObject({ planCode: "starter", seats: 2, version: 1 });
    expect(after).toMatchObject({ planCode: "team", seats: 5, version: 2 });
  });

  it("refuses a write based on a stale version", async () => {
    const client = clientFor(agentFor("cus_1"));
    await client.setEntitlement("cus_1", { planCode: "team", seats: 5, expectedVersion: 1 });

    const stale = client.setEntitlement("cus_1", { planCode: "pro", seats: 9, expectedVersion: 1 });

    expect(await codeOf(stale)).toBe("version_conflict");
    expect(await client.getEntitlement("cus_1")).toMatchObject({ planCode: "team", version: 2 });
  });

  it("lets exactly one of several concurrent writers win", async () => {
    const client = clientFor(agentFor("cus_1"));
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        codeOf(
          client.setEntitlement("cus_1", { planCode: "team", seats: i + 1, expectedVersion: 1 }),
        ),
      ),
    );

    expect(results.filter((result) => result === "ok")).toHaveLength(1);
    expect(results.filter((result) => result === "version_conflict")).toHaveLength(5);
  });

  it("keeps tenants and customers apart", async () => {
    const otherCustomer = clientFor(agentFor("cus_2"));
    expect(await codeOf(otherCustomer.getEntitlement("cus_1"))).toBe("not_found");

    await clientFor(agentFor("cus_1", "ten_b")).setEntitlement("cus_1", {
      planCode: "pro",
      seats: 9,
      expectedVersion: 1,
    });
    expect(await clientFor(agentFor("cus_1")).getEntitlement("cus_1")).toMatchObject({
      planCode: "starter",
      version: 1,
    });
  });
});
