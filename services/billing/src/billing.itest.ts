import {
  asRole,
  connect,
  createDatabase,
  DB_ROLES,
  dropDatabase,
  TEST_ROLE_PASSWORD,
  testPostgresUrl,
  withRowScope,
} from "@proofdesk/db";
import type { Principal } from "@proofdesk/service";
import { ServiceApiError } from "@proofdesk/service";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBillingApp } from "./app.ts";
import { createBillingClient } from "./client.ts";
import type { BillingDatabase } from "./schema.ts";

const NOW = new Date("2026-03-15T10:00:00.000Z");
const HEADER = "x-test-principal";

const agentFor = (customerId: string, tenantId = "ten_a"): Principal => ({
  tenantId,
  actor: "agent",
  subject: "agent:test",
  customerId,
  scopes: ["billing:read", "billing:refund"],
});
const staff: Principal = {
  tenantId: "ten_a",
  actor: "staff",
  subject: "staff:1",
  scopes: ["billing:read", "billing:refund"],
};

/** Owner connection, for seeding and for checking what really got written. */
let db: ReturnType<typeof connect<BillingDatabase>>;
/** The connection the service uses: the restricted `billing_app` role. */
let appDb: ReturnType<typeof connect<BillingDatabase>>;
let database: string;
let app: ReturnType<typeof createBillingApp>;

function clientFor(principal: Principal | null) {
  return createBillingClient({
    baseUrl: "http://billing.test",
    fetch: (request) => app.fetch(request),
    headers: () => (principal ? { [HEADER]: JSON.stringify(principal) } : {}),
  });
}

async function seedInvoice(input: {
  id: string;
  tenantId?: string;
  customerId: string;
  amountCents?: number;
  payments: { id: string; status?: "succeeded" | "failed" | "disputed" }[];
}) {
  const tenantId = input.tenantId ?? "ten_a";
  const amountCents = input.amountCents ?? 100_00;
  const planId = `plan_${tenantId}`;
  await db
    .insertInto("plans")
    .values({
      id: planId,
      tenantId,
      code: "team",
      name: "Team",
      billingInterval: "month",
      priceCents: amountCents,
      currency: "USD",
    })
    .onConflict((conflict) => conflict.doNothing())
    .execute();
  await db
    .insertInto("subscriptions")
    .values({
      id: `sub_${input.id}`,
      tenantId,
      customerId: input.customerId,
      planId,
      status: "active",
      seats: 1,
      startedAt: NOW,
      currentPeriodStart: NOW,
      currentPeriodEnd: NOW,
      canceledAt: null,
    })
    .execute();
  await db
    .insertInto("invoices")
    .values({
      id: input.id,
      tenantId,
      customerId: input.customerId,
      subscriptionId: `sub_${input.id}`,
      number: `INV-${input.id}`,
      status: "paid",
      amountCents,
      currency: "USD",
      periodStart: NOW,
      periodEnd: NOW,
      issuedAt: NOW,
      reference: null,
    })
    .execute();
  for (const payment of input.payments) {
    await db
      .insertInto("payments")
      .values({
        id: payment.id,
        tenantId,
        customerId: input.customerId,
        invoiceId: input.id,
        amountCents,
        status: payment.status ?? "succeeded",
        createdAt: NOW,
      })
      .execute();
  }
}

const refundCount = async () => (await db.selectFrom("refunds").select("id").execute()).length;

async function expectApiError(promise: Promise<unknown>, status: number, code: string) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ServiceApiError);
  expect(error).toMatchObject({ status, code });
}

beforeEach(async () => {
  database = `billing_${Math.random().toString(36).slice(2, 12)}`;
  const url = await createDatabase(testPostgresUrl(), database, { template: "tpl_billing" });
  db = connect<BillingDatabase>(url);
  appDb = connect<BillingDatabase>(asRole(url, DB_ROLES.billing, TEST_ROLE_PASSWORD), {
    maxConnections: 10,
  });
  let sequence = 0;
  app = createBillingApp({
    db: appDb,
    clock: () => NOW,
    newId: (prefix) => `${prefix}_${++sequence}`,
    authenticate: (request) => {
      const header = request.headers.get(HEADER);
      return header ? (JSON.parse(header) as Principal) : null;
    },
  });
  await seedInvoice({ id: "inv_a1", customerId: "cus_a1", payments: [{ id: "pay_a1" }] });
});

afterEach(async () => {
  await appDb.destroy();
  await db.destroy();
  await dropDatabase(testPostgresUrl(), database);
});

describe("reading", () => {
  it("returns a customer's invoices with payments and refund totals", async () => {
    const billing = clientFor(agentFor("cus_a1"));
    await billing.createRefund(
      { paymentId: "pay_a1", amountCents: 30_00, reason: "service_credit" },
      "key-00000001",
    );

    const invoices = await billing.listInvoices("cus_a1");

    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({
      number: "INV-inv_a1",
      amountCents: 100_00,
      payments: [{ id: "pay_a1", refundedCents: 30_00, refunds: [{ amountCents: 30_00 }] }],
    });
  });

  it("filters invoices by number", async () => {
    const billing = clientFor(agentFor("cus_a1"));
    expect(await billing.listInvoices("cus_a1", { number: "INV-inv_a1" })).toHaveLength(1);
    expect(await billing.listInvoices("cus_a1", { number: "INV-nope" })).toHaveLength(0);
  });

  it("returns subscriptions with their plan", async () => {
    const subscriptions = await clientFor(agentFor("cus_a1")).listSubscriptions("cus_a1");
    expect(subscriptions).toMatchObject([{ seats: 1, plan: { code: "team", priceCents: 100_00 } }]);
  });
});

describe("access", () => {
  it("rejects a request with no principal", async () => {
    await expectApiError(clientFor(null).listInvoices("cus_a1"), 401, "unauthenticated");
  });

  it("hides another customer's records from a customer-scoped caller", async () => {
    await seedInvoice({ id: "inv_a2", customerId: "cus_a2", payments: [{ id: "pay_a2" }] });
    const billing = clientFor(agentFor("cus_a1"));

    await expectApiError(billing.listInvoices("cus_a2"), 404, "not_found");
    await expectApiError(
      billing.createRefund(
        { paymentId: "pay_a2", amountCents: 1_00, reason: "customer_request" },
        "key-00000002",
      ),
      404,
      "payment_not_found",
    );
    expect(await refundCount()).toBe(0);
  });

  it("hides another tenant's records, even from staff", async () => {
    await seedInvoice({
      id: "inv_b1",
      tenantId: "ten_b",
      customerId: "cus_b1",
      payments: [{ id: "pay_b1" }],
    });
    const billing = clientFor(staff);

    expect(await billing.listInvoices("cus_b1")).toEqual([]);
    await expectApiError(
      billing.createRefund(
        { paymentId: "pay_b1", amountCents: 1_00, reason: "customer_request" },
        "key-00000003",
      ),
      404,
      "payment_not_found",
    );
    expect(await refundCount()).toBe(0);
  });
  it("rejects a caller whose credential lacks the scope", async () => {
    const readOnly = clientFor({ ...agentFor("cus_a1"), scopes: ["billing:read"] });
    const noScopes = clientFor({ ...agentFor("cus_a1"), scopes: [] });

    expect(await readOnly.listInvoices("cus_a1")).toHaveLength(1);
    await expectApiError(
      readOnly.createRefund(
        { paymentId: "pay_a1", amountCents: 1_00, reason: "customer_request" },
        "key-00000004",
      ),
      403,
      "insufficient_scope",
    );
    await expectApiError(noScopes.listInvoices("cus_a1"), 403, "insufficient_scope");
    expect(await refundCount()).toBe(0);
  });
});

// These tests skip the service and talk to the database as the service's own
// role, with queries that have no tenant or customer filter at all. Whatever
// isolation holds here is enforced by Postgres, not by application code.
describe("row-level security", () => {
  beforeEach(async () => {
    await seedInvoice({ id: "inv_a2", customerId: "cus_a2", payments: [{ id: "pay_a2" }] });
    await seedInvoice({
      id: "inv_b1",
      tenantId: "ten_b",
      customerId: "cus_b1",
      payments: [{ id: "pay_b1" }],
    });
  });

  const allInvoiceIds = (scope: Parameters<typeof withRowScope>[1]) =>
    withRowScope(appDb, scope, async (trx) =>
      (await trx.selectFrom("invoices").select("id").orderBy("id").execute()).map((row) => row.id),
    );

  it("shows an unfiltered query only the tenant's rows", async () => {
    expect(await allInvoiceIds({ tenantId: "ten_a" })).toEqual(["inv_a1", "inv_a2"]);
    expect(await allInvoiceIds({ tenantId: "ten_b" })).toEqual(["inv_b1"]);
  });

  it("shows a customer-scoped query only that customer's rows", async () => {
    expect(await allInvoiceIds({ tenantId: "ten_a", customerId: "cus_a2" })).toEqual(["inv_a2"]);
    expect(await allInvoiceIds({ tenantId: "ten_b", customerId: "cus_a2" })).toEqual([]);
  });

  it("shows nothing to a query that set no scope", async () => {
    for (const table of ["plans", "subscriptions", "invoices", "payments", "refunds"] as const) {
      expect(await appDb.selectFrom(table).selectAll().execute()).toEqual([]);
    }
  });

  it("refuses a refund row for a payment the scope cannot see", async () => {
    const insert = (
      scope: Parameters<typeof withRowScope>[1],
      paymentId: string,
      tenantId: string,
    ) =>
      withRowScope(appDb, scope, (trx) =>
        trx
          .insertInto("refunds")
          .values({
            id: `ref_${paymentId}`,
            tenantId,
            paymentId,
            amountCents: 1_00,
            reason: "customer_request",
            createdBy: "attacker",
            createdAt: NOW,
            idempotencyKey: `rls-${paymentId}-${tenantId}`,
            requestFingerprint: "x",
          })
          .execute(),
      );

    // Another tenant's payment, another customer's payment, and a row that
    // claims a different tenant than the scope.
    await expect(insert({ tenantId: "ten_a" }, "pay_b1", "ten_a")).rejects.toThrow(
      /row-level security/,
    );
    await expect(insert({ tenantId: "ten_a" }, "pay_b1", "ten_b")).rejects.toThrow(
      /row-level security/,
    );
    await expect(
      insert({ tenantId: "ten_a", customerId: "cus_a1" }, "pay_a2", "ten_a"),
    ).rejects.toThrow(/row-level security/);
    expect(await refundCount()).toBe(0);
  });

  it("gives the service role no way to change or delete billing history", async () => {
    const inScope = <T>(
      fn: (
        trx: Parameters<Parameters<typeof withRowScope<BillingDatabase, T>>[2]>[0],
      ) => Promise<T>,
    ) => withRowScope(appDb, { tenantId: "ten_a" }, fn);

    await expect(
      inScope((trx) => trx.updateTable("invoices").set({ amountCents: 1 }).execute()),
    ).rejects.toThrow(/permission denied/);
    await expect(
      inScope((trx) => trx.updateTable("payments").set({ amountCents: 1 }).execute()),
    ).rejects.toThrow(/permission denied/);
    await expect(
      inScope((trx) => trx.updateTable("payments").set({ status: "failed" }).execute()),
    ).rejects.toThrow(/row-level security/);
    await expect(inScope((trx) => trx.deleteFrom("refunds").execute())).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      inScope((trx) =>
        sql`set local row_security = off`
          .execute(trx)
          .then(() => trx.selectFrom("invoices").selectAll().execute()),
      ),
    ).rejects.toThrow();
  });
});

describe("refund invariants", () => {
  const billing = () => clientFor(agentFor("cus_a1"));

  it("refuses to refund more than was paid, across several refunds", async () => {
    await billing().createRefund(
      { paymentId: "pay_a1", amountCents: 70_00, reason: "customer_request" },
      "key-00000010",
    );
    await expectApiError(
      billing().createRefund(
        { paymentId: "pay_a1", amountCents: 30_01, reason: "customer_request" },
        "key-00000011",
      ),
      422,
      "amount_exceeds_refundable",
    );
    await billing().createRefund(
      { paymentId: "pay_a1", amountCents: 30_00, reason: "customer_request" },
      "key-00000012",
    );
    expect(await refundCount()).toBe(2);
  });

  it("refuses to refund a payment that failed or is disputed", async () => {
    await seedInvoice({
      id: "inv_a3",
      customerId: "cus_a1",
      payments: [
        { id: "pay_failed", status: "failed" },
        { id: "pay_disputed", status: "disputed" },
      ],
    });
    for (const paymentId of ["pay_failed", "pay_disputed"]) {
      await expectApiError(
        billing().createRefund(
          { paymentId, amountCents: 1_00, reason: "customer_request" },
          `key-${paymentId}`,
        ),
        422,
        "payment_not_refundable",
      );
    }
    expect(await refundCount()).toBe(0);
  });

  it("rejects malformed requests", async () => {
    const send = (body: unknown, key = "key-00000020") =>
      app.fetch(
        new Request("http://billing.test/refunds", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": key,
            [HEADER]: JSON.stringify(agentFor("cus_a1")),
          },
          body: JSON.stringify(body),
        }),
      );

    const valid = { paymentId: "pay_a1", amountCents: 1_00, reason: "customer_request" };
    expect((await send({ ...valid, amountCents: -5 })).status).toBe(400);
    expect((await send({ ...valid, amountCents: 1.5 })).status).toBe(400);
    expect((await send({ ...valid, reason: "because" })).status).toBe(400);
    expect((await send({ ...valid, tenantId: "ten_b" })).status).toBe(400);
    expect((await send(valid, "short")).status).toBe(400);
    expect(await refundCount()).toBe(0);
  });

  it("does not let concurrent refunds overspend one payment", async () => {
    const attempts = Array.from({ length: 8 }, (_, i) =>
      billing()
        .createRefund(
          { paymentId: "pay_a1", amountCents: 40_00, reason: "customer_request" },
          `key-concurrent-${i}`,
        )
        .then(
          () => "ok",
          (error: ServiceApiError) => error.code,
        ),
    );
    const results = await Promise.all(attempts);

    expect(results.filter((result) => result === "ok")).toHaveLength(2);
    expect(results.filter((result) => result === "amount_exceeds_refundable")).toHaveLength(6);
    const [invoice] = await billing().listInvoices("cus_a1");
    expect(invoice?.payments[0]?.refundedCents).toBe(80_00);
  });
});

describe("idempotency", () => {
  const request = { paymentId: "pay_a1", amountCents: 25_00, reason: "customer_request" } as const;
  const billing = () => clientFor(agentFor("cus_a1"));

  it("returns the first refund when the same request is retried", async () => {
    const first = await billing().createRefund(request, "key-retry-0001");
    const second = await billing().createRefund(request, "key-retry-0001");

    expect(second).toEqual(first);
    expect(await refundCount()).toBe(1);
  });

  it("issues one refund when the same request arrives many times at once", async () => {
    const refunds = await Promise.all(
      Array.from({ length: 10 }, () => billing().createRefund(request, "key-burst-0001")),
    );

    expect(new Set(refunds.map((refund) => refund.id)).size).toBe(1);
    expect(await refundCount()).toBe(1);
  });

  it("rejects a key that is reused for a different request", async () => {
    await billing().createRefund(request, "key-reuse-0001");
    await expectApiError(
      billing().createRefund({ ...request, amountCents: 26_00 }, "key-reuse-0001"),
      409,
      "idempotency_key_reused",
    );
    expect(await refundCount()).toBe(1);
  });

  it("requires a key", async () => {
    const response = await app.fetch(
      new Request("http://billing.test/refunds", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [HEADER]: JSON.stringify(agentFor("cus_a1")),
        },
        body: JSON.stringify(request),
      }),
    );
    expect(response.status).toBe(400);
    expect(await refundCount()).toBe(0);
  });
});

describe("plan changes", () => {
  const SUB = "sub_inv_a1";
  const planner = (customerId = "cus_a1") =>
    clientFor({ ...agentFor(customerId), scopes: ["billing:read", "billing:plan"] });

  beforeEach(async () => {
    await db
      .insertInto("plans")
      .values([
        {
          id: "plan_pro",
          tenantId: "ten_a",
          code: "pro",
          name: "Pro",
          billingInterval: "month",
          priceCents: 200_00,
          currency: "USD",
        },
        {
          id: "plan_year",
          tenantId: "ten_a",
          code: "team-annual",
          name: "Team annual",
          billingInterval: "year",
          priceCents: 900_00,
          currency: "USD",
        },
        {
          id: "plan_other",
          tenantId: "ten_b",
          code: "pro",
          name: "Pro",
          billingInterval: "month",
          priceCents: 1,
          currency: "USD",
        },
      ])
      .execute();
  });

  const subscription = () =>
    db
      .selectFrom("subscriptions")
      .select(["planId", "seats"])
      .where("id", "=", SUB)
      .executeTakeFirstOrThrow();

  it("changes plan and seats and records what was replaced", async () => {
    const change = await planner().changeSubscription(
      SUB,
      { planCode: "pro", seats: 4 },
      "key-plan-0001",
    );

    expect(change).toMatchObject({
      subscriptionId: SUB,
      from: { planCode: "team", seats: 1 },
      to: { planCode: "pro", seats: 4 },
      status: "applied",
    });
    expect(await subscription()).toEqual({ planId: "plan_pro", seats: 4 });
  });

  it("applies a repeated request once", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        planner().changeSubscription(SUB, { planCode: "pro", seats: 4 }, "key-plan-0002"),
      ),
    );
    expect(new Set(results.map((change) => change.id)).size).toBe(1);
    expect(await db.selectFrom("planChanges").select("id").execute()).toHaveLength(1);
  });

  it("refuses a plan that does not exist for this tenant, bills on another interval, or changes nothing", async () => {
    const attempt = (planCode: string, seats: number, key: string) =>
      planner().changeSubscription(SUB, { planCode, seats }, key);

    await expectApiError(attempt("enterprise", 2, "key-plan-0003"), 422, "plan_not_available");
    await expectApiError(
      attempt("team-annual", 2, "key-plan-0004"),
      422,
      "interval_change_not_supported",
    );
    await expectApiError(attempt("team", 1, "key-plan-0005"), 422, "no_change");
    expect(await subscription()).toEqual({ planId: "plan_ten_a", seats: 1 });
  });

  it("needs the plan scope and reaches only the caller's own subscriptions", async () => {
    await seedInvoice({ id: "inv_a2", customerId: "cus_a2", payments: [{ id: "pay_a2" }] });
    await expectApiError(
      clientFor(agentFor("cus_a1")).changeSubscription(
        SUB,
        { planCode: "pro", seats: 2 },
        "key-plan-0006",
      ),
      403,
      "insufficient_scope",
    );
    await expectApiError(
      planner("cus_a2").changeSubscription(SUB, { planCode: "pro", seats: 2 }, "key-plan-0007"),
      404,
      "subscription_not_found",
    );
    expect(await subscription()).toEqual({ planId: "plan_ten_a", seats: 1 });
  });

  it("reverts a change exactly, and reverting twice is harmless", async () => {
    const change = await planner().changeSubscription(
      SUB,
      { planCode: "pro", seats: 4 },
      "key-plan-0008",
    );

    const first = await planner().revertPlanChange(change.id);
    const second = await planner().revertPlanChange(change.id);

    expect(first.status).toBe("reverted");
    expect(second).toEqual(first);
    expect(await subscription()).toEqual({ planId: "plan_ten_a", seats: 1 });
  });

  it("refuses to revert once the subscription has been changed again", async () => {
    const first = await planner().changeSubscription(
      SUB,
      { planCode: "pro", seats: 4 },
      "key-plan-0009",
    );
    await planner().changeSubscription(SUB, { planCode: "pro", seats: 9 }, "key-plan-0010");

    await expectApiError(planner().revertPlanChange(first.id), 409, "subscription_changed_since");
    expect(await subscription()).toEqual({ planId: "plan_pro", seats: 9 });
  });

  it("lets the service role change a subscription's plan and seats and nothing else", async () => {
    const inScope = <T>(
      fn: (
        trx: Parameters<Parameters<typeof withRowScope<BillingDatabase, T>>[2]>[0],
      ) => Promise<T>,
    ) => withRowScope(appDb, { tenantId: "ten_a" }, fn);
    await expect(
      inScope((trx) => trx.updateTable("subscriptions").set({ status: "canceled" }).execute()),
    ).rejects.toThrow(/permission denied/);
    await expect(
      inScope((trx) => trx.updateTable("subscriptions").set({ customerId: "cus_a2" }).execute()),
    ).rejects.toThrow(/permission denied/);
  });

  it("closes an account only through the one function, and only inside the row scope", async () => {
    const close = (scope: { tenantId: string; customerId?: string }, customerId: string) =>
      withRowScope(appDb, scope, (trx) =>
        sql`select close_customer_account(${scope.tenantId}, ${customerId}, now())`.execute(trx),
      );
    // Scoped to one customer, the function refuses to touch another.
    await expect(close({ tenantId: "ten_a", customerId: "cus_a1" }, "cus_a2")).rejects.toThrow(
      /not scoped to this customer/,
    );
    // And with no scope at all it refuses everyone.
    await expect(
      sql`select close_customer_account('ten_a', 'cus_a1', now())`.execute(appDb),
    ).rejects.toThrow(/not scoped to this customer/);
    await expect(
      withRowScope(appDb, { tenantId: "ten_a" }, (trx) =>
        trx.updateTable("invoices").set({ reference: null }).execute(),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});
