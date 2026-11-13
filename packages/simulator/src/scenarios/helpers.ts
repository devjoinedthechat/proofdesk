import type { ScenarioBuilder } from "../builder.ts";
import type { TenantSlug } from "../catalog.ts";
import { formatMoney } from "../world.ts";

export const usd = (cents: number) => formatMoney(cents, "USD");

/** A customer with one subscription and no invoices yet. */
export function account(
  b: ScenarioBuilder,
  slug: TenantSlug,
  name: string,
  plan: string,
  seats: number,
  startedDaysAgo: number,
) {
  const customer = b.customer(slug, { name });
  const subscription = b.subscription(customer, { plan, seats, startedDaysAgo });
  return { customer, subscription };
}

/** An invoice that was paid once, on the day it was issued. */
export function paidInvoice(
  b: ScenarioBuilder,
  subscription: Parameters<ScenarioBuilder["invoice"]>[0],
  daysAgo: number,
  reference?: string,
) {
  const invoice = b.invoice(subscription, {
    issuedDaysAgo: daysAgo,
    ...(reference === undefined ? {} : { reference }),
  });
  const payment = b.payment(invoice, { daysAgo });
  return { invoice, payment };
}
