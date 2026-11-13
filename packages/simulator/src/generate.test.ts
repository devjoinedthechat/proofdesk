import { describe, expect, it } from "vitest";
import { generateCompany } from "./generate.ts";
import { hashSeed, Prng } from "./prng.ts";
import { addMonths, formatMoney, wholeDaysBetween } from "./world.ts";

describe("Prng", () => {
  it("repeats its sequence for the same seed", () => {
    const a = new Prng(7);
    const b = new Prng(7);
    expect(Array.from({ length: 20 }, () => a.next())).toEqual(
      Array.from({ length: 20 }, () => b.next()),
    );
  });

  it("stays inside the requested integer range", () => {
    const rng = new Prng(hashSeed("range"));
    const values = Array.from({ length: 2000 }, () => rng.int(3, 6));
    expect(new Set(values)).toEqual(new Set([3, 4, 5, 6]));
  });
});

describe("generateCompany", () => {
  it("builds the same company twice from one seed", () => {
    expect(generateCompany({ seed: 42 })).toEqual(generateCompany({ seed: 42 }));
  });

  it("builds a different company from a different seed", () => {
    const a = generateCompany({ seed: 42 });
    const b = generateCompany({ seed: 43 });
    expect(a.customers.map((c) => c.id)).not.toEqual(b.customers.map((c) => c.id));
  });

  it("keeps every record consistent with the records it points to", () => {
    const world = generateCompany({ seed: 42 });
    const customers = new Map(world.customers.map((row) => [row.id, row]));
    const plans = new Map(world.plans.map((row) => [row.id, row]));
    const subscriptions = new Map(world.subscriptions.map((row) => [row.id, row]));
    const invoices = new Map(world.invoices.map((row) => [row.id, row]));

    expect(world.customers.length).toBe(40);
    expect(world.invoices.length).toBeGreaterThan(100);

    for (const subscription of world.subscriptions) {
      expect(customers.get(subscription.customerId)?.tenantId).toBe(subscription.tenantId);
      expect(plans.get(subscription.planId)?.tenantId).toBe(subscription.tenantId);
    }
    for (const invoice of world.invoices) {
      const subscription = subscriptions.get(invoice.subscriptionId);
      const plan = plans.get(subscription?.planId ?? "");
      expect(invoice.customerId).toBe(subscription?.customerId);
      expect(invoice.amountCents).toBe((plan?.priceCents ?? 0) * (subscription?.seats ?? 0));
    }
    for (const payment of world.payments) {
      const invoice = invoices.get(payment.invoiceId);
      expect(payment.customerId).toBe(invoice?.customerId);
      expect(payment.tenantId).toBe(invoice?.tenantId);
    }
  });

  it("gives every paid invoice exactly one successful payment", () => {
    const world = generateCompany({ seed: 42 });
    for (const invoice of world.invoices) {
      const succeeded = world.payments.filter(
        (payment) => payment.invoiceId === invoice.id && payment.status === "succeeded",
      );
      expect(succeeded).toHaveLength(1);
    }
  });

  it("never reuses an identifier or an invoice number within a tenant", () => {
    const world = generateCompany({ seed: 42 });
    const ids = [
      ...world.customers,
      ...world.subscriptions,
      ...world.invoices,
      ...world.payments,
    ].map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);

    const numbers = world.invoices.map((invoice) => `${invoice.tenantId}/${invoice.number}`);
    expect(new Set(numbers).size).toBe(numbers.length);
  });
});

describe("date and money helpers", () => {
  it("clamps month arithmetic to the end of a shorter month", () => {
    expect(addMonths(new Date("2026-01-31T10:00:00Z"), 1).toISOString()).toBe(
      "2026-02-28T10:00:00.000Z",
    );
    expect(addMonths(new Date("2025-11-15T10:00:00Z"), 3).toISOString()).toBe(
      "2026-02-15T10:00:00.000Z",
    );
  });

  it("counts whole days, rounding down", () => {
    const start = new Date("2026-03-01T10:00:00Z");
    expect(wholeDaysBetween(start, new Date("2026-03-15T09:59:59Z"))).toBe(13);
    expect(wholeDaysBetween(start, new Date("2026-03-15T10:00:00Z"))).toBe(14);
  });

  it("formats money with separators", () => {
    expect(formatMoney(87_00, "USD")).toBe("$87.00");
    expect(formatMoney(1_234_56, "USD")).toBe("$1,234.56");
  });
});
