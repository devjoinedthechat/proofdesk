import { connect, createDatabase, dropDatabase, testPostgresUrl } from "@proofdesk/db";
import type { Principal } from "@proofdesk/service";
import { ServiceApiError } from "@proofdesk/service";
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
});
const staff: Principal = { tenantId: "ten_a", actor: "staff", subject: "staff:1" };

let db: ReturnType<typeof connect<BillingDatabase>>;
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
  db = connect<BillingDatabase>(url, { maxConnections: 10 });
  let sequence = 0;
  app = createBillingApp({
    db,
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
