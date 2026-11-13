export type TicketStatus =
  | "open"
  | "waiting_approval"
  | "waiting_customer"
  | "handed_to_staff"
  | "resolved"
  | "refused";

export type TicketCategory = "refund" | "plan_change" | "data_deletion";

export type TenantRow = {
  id: string;
  slug: string;
  name: string;
  currency: string;
  refundWindowDays: number;
  refundApprovalLimitCents: number;
};

export type CustomerRow = {
  id: string;
  tenantId: string;
  email: string;
  name: string;
  createdAt: Date;
};

export type TicketRow = {
  id: string;
  tenantId: string;
  customerId: string;
  category: TicketCategory;
  subject: string;
  body: string;
  status: TicketStatus;
  createdAt: Date;
};

/**
 * The authority a signed-in customer gave the agent by submitting a ticket:
 * act for this customer, within these scopes, until it expires or is revoked.
 */
export type TicketGrantRow = {
  ticketId: string;
  tenantId: string;
  customerId: string;
  scopes: string[];
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
};

/** One row per signed assertion, so every token the agent obtained traces to a ticket. */
export type GrantAssertionRow = {
  jti: string;
  ticketId: string;
  tenantId: string;
  scope: string;
  issuedTo: string;
  issuedAt: Date;
};

/** The application database: who the tenants and customers are, and their tickets. */
export type AppDatabase = {
  tenants: TenantRow;
  customers: CustomerRow;
  tickets: TicketRow;
  ticketGrants: TicketGrantRow;
  grantAssertions: GrantAssertionRow;
};
