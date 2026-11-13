import type { InvoiceRow, PlanRow, SubscriptionRow } from "@proofdesk/billing";
import { CATALOG, TENANT_SLUGS } from "./catalog.ts";
import { Prng } from "./prng.ts";
import { addMonths, daysBefore, emptyWorld, SIM_NOW, type World } from "./world.ts";

const FIRST_NAMES = [
  "Amara",
  "Bao",
  "Carmen",
  "Dmitri",
  "Eleni",
  "Farid",
  "Greta",
  "Hiro",
  "Imani",
  "Jonas",
  "Keiko",
  "Luca",
  "Meera",
  "Nadia",
  "Omar",
  "Priya",
  "Quentin",
  "Rosa",
  "Soren",
  "Thandi",
  "Ugo",
  "Vera",
  "Wen",
  "Ximena",
  "Yusuf",
  "Zofia",
] as const;

const LAST_NAMES = [
  "Abara",
  "Bergstrom",
  "Castillo",
  "Dang",
  "Eriksen",
  "Fontaine",
  "Guerrero",
  "Haddad",
  "Ivanova",
  "Jovanovic",
  "Kowalski",
  "Lindqvist",
  "Mbeki",
  "Nakamura",
  "Oyelaran",
  "Pereira",
  "Quispe",
  "Rahman",
  "Sandoval",
  "Tanaka",
  "Umarov",
  "Vasquez",
  "Wachira",
  "Yilmaz",
] as const;

export type GenerateOptions = {
  seed: number;
  now?: Date;
  customersPerTenant?: number;
};

export function invoiceNumber(sequence: number): string {
  return `INV-${String(sequence).padStart(6, "0")}`;
}

/**
 * Builds the background company: customers with months of ordinary billing
 * history. It is a pure function of its options. Scenarios add their own
 * customers on top, so this history is the noise an agent must not confuse
 * with the case in front of it.
 */
export function generateCompany(options: GenerateOptions): World {
  const now = options.now ?? SIM_NOW;
  const perTenant = options.customersPerTenant ?? 20;
  const rng = new Prng(options.seed);
  const world = emptyWorld();

  for (const slug of TENANT_SLUGS) {
    const { tenant, plans: planSpecs } = CATALOG[slug];
    world.tenants.push({ ...tenant });

    const plans: PlanRow[] = planSpecs.map((spec) => ({
      id: `plan_${slug}_${spec.code.replaceAll("-", "_")}`,
      tenantId: tenant.id,
      currency: tenant.currency,
      ...spec,
    }));
    world.plans.push(...plans);

    let invoiceSequence = 0;
    const usedEmails = new Set<string>();

    for (let i = 0; i < perTenant; i++) {
      const first = rng.pick(FIRST_NAMES);
      const last = rng.pick(LAST_NAMES);
      let email = `${first}.${last}@example.com`.toLowerCase();
      for (let n = 2; usedEmails.has(email); n++) {
        email = `${first}.${last}${n}@example.com`.toLowerCase();
      }
      usedEmails.add(email);

      const plan = rng.pick(plans);
      const monthsPerPeriod = plan.billingInterval === "year" ? 12 : 1;
      const startedAt = daysBefore(now, rng.int(20, 540));
      const canceled = rng.chance(0.1);

      const customer = {
        id: rng.id("cus"),
        tenantId: tenant.id,
        email,
        name: `${first} ${last}`,
        createdAt: startedAt,
      };
      world.customers.push(customer);

      const subscription: SubscriptionRow = {
        id: rng.id("sub"),
        tenantId: tenant.id,
        customerId: customer.id,
        planId: plan.id,
        status: "active",
        seats: rng.int(1, 8),
        startedAt,
        currentPeriodStart: startedAt,
        currentPeriodEnd: addMonths(startedAt, monthsPerPeriod),
        canceledAt: null,
      };

      for (let period = 0; ; period++) {
        const periodStart = addMonths(startedAt, period * monthsPerPeriod);
        if (periodStart > now) break;
        const periodEnd = addMonths(startedAt, (period + 1) * monthsPerPeriod);
        subscription.currentPeriodStart = periodStart;
        subscription.currentPeriodEnd = periodEnd;

        invoiceSequence += 1;
        const invoice: InvoiceRow = {
          id: rng.id("inv"),
          tenantId: tenant.id,
          customerId: customer.id,
          subscriptionId: subscription.id,
          number: invoiceNumber(invoiceSequence),
          status: "paid",
          amountCents: plan.priceCents * subscription.seats,
          currency: plan.currency,
          periodStart,
          periodEnd,
          issuedAt: periodStart,
          reference: null,
        };
        world.invoices.push(invoice);

        // One charge in ten fails first and succeeds on the retry a day later.
        let paidAt = periodStart;
        if (rng.chance(0.1)) {
          world.payments.push({
            id: rng.id("pay"),
            tenantId: tenant.id,
            customerId: customer.id,
            invoiceId: invoice.id,
            amountCents: invoice.amountCents,
            status: "failed",
            createdAt: periodStart,
          });
          paidAt = new Date(Math.min(periodStart.getTime() + 86_400_000, now.getTime()));
        }
        world.payments.push({
          id: rng.id("pay"),
          tenantId: tenant.id,
          customerId: customer.id,
          invoiceId: invoice.id,
          amountCents: invoice.amountCents,
          status: "succeeded",
          createdAt: paidAt,
        });
      }

      if (canceled) {
        subscription.status = "canceled";
        subscription.canceledAt = subscription.currentPeriodStart;
      }
      world.subscriptions.push(subscription);
      world.entitlements.push({
        tenantId: tenant.id,
        customerId: customer.id,
        planCode: plan.code,
        seats: subscription.seats,
        status: canceled ? "suspended" : "active",
        version: 1,
        updatedAt: subscription.currentPeriodStart,
        updatedBy: "system:billing-sync",
      });
    }
  }

  return world;
}
