import type {
  InvoiceRow,
  PaymentRow,
  PlanRow,
  RefundRow,
  SubscriptionRow,
} from "@proofdesk/billing";
import type { CustomerRow, TenantRow, TicketRow } from "@proofdesk/db";
import type { EntitlementRow } from "@proofdesk/entitlements";

/** Every row of the simulated company, across its three databases. */
export type World = {
  tenants: TenantRow[];
  customers: CustomerRow[];
  tickets: TicketRow[];
  plans: PlanRow[];
  subscriptions: SubscriptionRow[];
  invoices: InvoiceRow[];
  payments: PaymentRow[];
  refunds: RefundRow[];
  entitlements: EntitlementRow[];
};

export function emptyWorld(): World {
  return {
    tenants: [],
    customers: [],
    tickets: [],
    plans: [],
    subscriptions: [],
    invoices: [],
    payments: [],
    refunds: [],
    entitlements: [],
  };
}

/** The instant every simulation treats as "now". Nothing reads the real clock. */
export const SIM_NOW = new Date("2026-03-15T10:00:00.000Z");

const DAY_MS = 24 * 60 * 60 * 1000;

export function daysBefore(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

/** Whole days elapsed from `earlier` to `later`, rounded down. */
export function wholeDaysBetween(earlier: Date, later: Date): number {
  return Math.floor((later.getTime() - earlier.getTime()) / DAY_MS);
}

/** Adds calendar months in UTC, clamping to the last day of a shorter month. */
export function addMonths(date: Date, months: number): Date {
  const result = new Date(date);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

export function formatMoney(cents: number, currency: string): string {
  const amount = (cents / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return currency === "USD" ? `$${amount}` : `${amount} ${currency}`;
}
