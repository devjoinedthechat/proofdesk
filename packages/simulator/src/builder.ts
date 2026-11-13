import type {
  InvoiceRow,
  InvoiceStatus,
  PaymentRow,
  PaymentStatus,
  RefundReason,
  RefundRow,
  SubscriptionRow,
  SubscriptionStatus,
} from "@proofdesk/billing";
import type { CustomerRow, TenantRow, TicketRow } from "@proofdesk/db";
import { CATALOG, type TenantSlug } from "./catalog.ts";
import { invoiceNumber } from "./generate.ts";
import { hashSeed, Prng } from "./prng.ts";
import { addMonths, daysBefore, emptyWorld, SIM_NOW, type World } from "./world.ts";

const MINUTE_MS = 60_000;

/**
 * Adds one scenario's records on top of the background company. Identifiers
 * come from a generator seeded by the scenario id, so they are stable and
 * carry no hint about the scenario they belong to.
 */
export class ScenarioBuilder {
  readonly now: Date;
  /** Only the rows this scenario added. */
  readonly added: World = emptyWorld();
  readonly #base: World;
  readonly #rng: Prng;
  readonly #invoiceSequence = new Map<string, number>();

  constructor(base: World, scenarioId: string, now: Date = SIM_NOW) {
    this.#base = base;
    this.#rng = new Prng(hashSeed(`scenario:${scenarioId}`));
    this.now = now;
    for (const invoice of base.invoices) {
      const sequence = Number(invoice.number.replace("INV-", ""));
      const current = this.#invoiceSequence.get(invoice.tenantId) ?? 0;
      this.#invoiceSequence.set(invoice.tenantId, Math.max(current, sequence));
    }
  }

  tenant(slug: TenantSlug): TenantRow {
    return CATALOG[slug].tenant;
  }

  customer(slug: TenantSlug, input: { name: string; createdDaysAgo?: number }): CustomerRow {
    const row: CustomerRow = {
      id: this.#rng.id("cus"),
      tenantId: this.tenant(slug).id,
      email: `${input.name.toLowerCase().replaceAll(/[^a-z]+/g, ".")}@example.org`,
      name: input.name,
      createdAt: daysBefore(this.now, input.createdDaysAgo ?? 400),
    };
    this.added.customers.push(row);
    return row;
  }

  subscription(
    customer: CustomerRow,
    input: { plan: string; seats?: number; startedDaysAgo: number; status?: SubscriptionStatus },
  ): SubscriptionRow {
    const plan = this.#base.plans.find(
      (candidate) => candidate.tenantId === customer.tenantId && candidate.code === input.plan,
    );
    if (!plan) throw new Error(`Unknown plan "${input.plan}" for tenant ${customer.tenantId}`);

    const startedAt = daysBefore(this.now, input.startedDaysAgo);
    const status = input.status ?? "active";
    const row: SubscriptionRow = {
      id: this.#rng.id("sub"),
      tenantId: customer.tenantId,
      customerId: customer.id,
      planId: plan.id,
      status,
      seats: input.seats ?? 1,
      startedAt,
      currentPeriodStart: startedAt,
      currentPeriodEnd: addMonths(startedAt, plan.billingInterval === "year" ? 12 : 1),
      canceledAt: status === "canceled" ? daysBefore(this.now, 1) : null,
    };
    this.added.subscriptions.push(row);
    this.added.entitlements.push({
      tenantId: customer.tenantId,
      customerId: customer.id,
      planCode: plan.code,
      seats: row.seats,
      status: status === "canceled" ? "suspended" : "active",
      version: 1,
      updatedAt: startedAt,
      updatedBy: "system:billing-sync",
    });
    return row;
  }

  /** An invoice for one period of the subscription. The amount defaults to price times seats. */
  invoice(
    subscription: SubscriptionRow,
    input: { issuedDaysAgo: number; status?: InvoiceStatus; amountCents?: number },
  ): InvoiceRow {
    const plan = this.#base.plans.find((candidate) => candidate.id === subscription.planId);
    if (!plan) throw new Error(`Subscription ${subscription.id} has no plan`);

    const sequence = (this.#invoiceSequence.get(subscription.tenantId) ?? 0) + 1;
    this.#invoiceSequence.set(subscription.tenantId, sequence);
    const issuedAt = daysBefore(this.now, input.issuedDaysAgo);
    const row: InvoiceRow = {
      id: this.#rng.id("inv"),
      tenantId: subscription.tenantId,
      customerId: subscription.customerId,
      subscriptionId: subscription.id,
      number: invoiceNumber(sequence),
      status: input.status ?? "paid",
      amountCents: input.amountCents ?? plan.priceCents * subscription.seats,
      currency: plan.currency,
      periodStart: issuedAt,
      periodEnd: addMonths(issuedAt, plan.billingInterval === "year" ? 12 : 1),
      issuedAt,
    };
    this.added.invoices.push(row);
    return row;
  }

  payment(
    invoice: InvoiceRow,
    input: { daysAgo: number; minutesLater?: number; status?: PaymentStatus },
  ): PaymentRow {
    const at =
      daysBefore(this.now, input.daysAgo).getTime() + (input.minutesLater ?? 0) * MINUTE_MS;
    const row: PaymentRow = {
      id: this.#rng.id("pay"),
      tenantId: invoice.tenantId,
      customerId: invoice.customerId,
      invoiceId: invoice.id,
      amountCents: invoice.amountCents,
      status: input.status ?? "succeeded",
      createdAt: new Date(at),
    };
    this.added.payments.push(row);
    return row;
  }

  /** A refund that already happened before the ticket arrived. */
  refund(
    payment: PaymentRow,
    input: { daysAgo: number; reason: RefundReason; amountCents?: number },
  ): RefundRow {
    const id = this.#rng.id("ref");
    const row: RefundRow = {
      id,
      tenantId: payment.tenantId,
      paymentId: payment.id,
      amountCents: input.amountCents ?? payment.amountCents,
      reason: input.reason,
      createdBy: "staff:history",
      createdAt: daysBefore(this.now, input.daysAgo),
      idempotencyKey: `history:${id}`,
      requestFingerprint: "history",
    };
    this.added.refunds.push(row);
    return row;
  }

  ticket(customer: CustomerRow, input: { subject: string; body: string }): TicketRow {
    const row: TicketRow = {
      id: this.#rng.id("tkt"),
      tenantId: customer.tenantId,
      customerId: customer.id,
      category: "refund",
      subject: input.subject,
      body: input.body,
      status: "open",
      createdAt: this.now,
    };
    this.added.tickets.push(row);
    return row;
  }
}
