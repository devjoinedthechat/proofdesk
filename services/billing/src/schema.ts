export type BillingInterval = "month" | "year";
export type SubscriptionStatus = "active" | "past_due" | "canceled";
export type InvoiceStatus = "open" | "paid" | "void";
export type PaymentStatus = "succeeded" | "failed" | "disputed";
export type RefundReason = "duplicate_charge" | "customer_request" | "service_credit";

export type PlanRow = {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  billingInterval: BillingInterval;
  priceCents: number;
  currency: string;
};

export type SubscriptionRow = {
  id: string;
  tenantId: string;
  customerId: string;
  planId: string;
  status: SubscriptionStatus;
  seats: number;
  startedAt: Date;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  canceledAt: Date | null;
};

export type InvoiceRow = {
  id: string;
  tenantId: string;
  customerId: string;
  subscriptionId: string;
  number: string;
  status: InvoiceStatus;
  amountCents: number;
  currency: string;
  periodStart: Date;
  periodEnd: Date;
  issuedAt: Date;
  /** Free text entered by the customer at checkout. */
  reference: string | null;
};

export type PaymentRow = {
  id: string;
  tenantId: string;
  customerId: string;
  invoiceId: string;
  amountCents: number;
  status: PaymentStatus;
  createdAt: Date;
};

export type RefundRow = {
  id: string;
  tenantId: string;
  paymentId: string;
  amountCents: number;
  reason: RefundReason;
  createdBy: string;
  createdAt: Date;
  idempotencyKey: string;
  requestFingerprint: string;
};

export type PlanChangeRow = {
  id: string;
  tenantId: string;
  customerId: string;
  subscriptionId: string;
  fromPlanId: string;
  fromSeats: number;
  toPlanId: string;
  toSeats: number;
  status: "applied" | "reverted";
  createdBy: string;
  createdAt: Date;
  revertedAt: Date | null;
  idempotencyKey: string;
  requestFingerprint: string;
};

export type BillingDatabase = {
  plans: PlanRow;
  subscriptions: SubscriptionRow;
  invoices: InvoiceRow;
  payments: PaymentRow;
  refunds: RefundRow;
  planChanges: PlanChangeRow;
};
