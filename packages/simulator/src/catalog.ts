import type { BillingInterval } from "@proofdesk/billing";
import type { TenantRow } from "@proofdesk/db";

export type TenantSlug = "harbor" | "tallyfield";

type PlanSpec = {
  code: string;
  name: string;
  billingInterval: BillingInterval;
  priceCents: number;
};

export type TenantSpec = { tenant: TenantRow; plans: PlanSpec[] };

/**
 * The two fictional companies the agent works for. They differ in refund
 * window and approval limit, so one ticket can have two correct outcomes
 * depending on the tenant.
 */
export const CATALOG: Record<TenantSlug, TenantSpec> = {
  harbor: {
    tenant: {
      id: "ten_harbor",
      slug: "harbor",
      name: "Harbor Notes",
      currency: "USD",
      refundWindowDays: 14,
      refundApprovalLimitCents: 200_00,
    },
    plans: [
      { code: "starter-monthly", name: "Starter", billingInterval: "month", priceCents: 12_00 },
      { code: "team-monthly", name: "Team", billingInterval: "month", priceCents: 29_00 },
      { code: "business-monthly", name: "Business", billingInterval: "month", priceCents: 50_00 },
      { code: "team-annual", name: "Team (annual)", billingInterval: "year", priceCents: 290_00 },
    ],
  },
  tallyfield: {
    tenant: {
      id: "ten_tallyfield",
      slug: "tallyfield",
      name: "Tallyfield",
      currency: "USD",
      refundWindowDays: 30,
      refundApprovalLimitCents: 500_00,
    },
    plans: [
      { code: "basic-monthly", name: "Basic", billingInterval: "month", priceCents: 19_00 },
      { code: "pro-monthly", name: "Pro", billingInterval: "month", priceCents: 49_00 },
      { code: "pro-annual", name: "Pro (annual)", billingInterval: "year", priceCents: 490_00 },
    ],
  },
};

export const TENANT_SLUGS = Object.keys(CATALOG) as TenantSlug[];
