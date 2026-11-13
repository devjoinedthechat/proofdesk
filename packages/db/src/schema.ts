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
  /** The most the agent may refund for the tenant in 24 hours without approval. */
  agentDailyRefundCapCents: number;
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
  outcome: string | null;
  reasonCode: string | null;
  reply: string | null;
  resolvedAt: Date | null;
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

/** JSON columns are typed as `unknown`; the code that owns them knows their shape. */
export type AgentRunRow = {
  ticketId: string;
  tenantId: string;
  customerId: string;
  step: number;
  state: unknown;
  tools: unknown;
  lastOutput: unknown;
  versions: unknown;
  createdAt: Date;
  updatedAt: Date;
};

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export type ApprovalRow = {
  id: string;
  ticketId: string;
  tenantId: string;
  customerId: string;
  step: number;
  tool: string;
  summary: unknown;
  reason: string;
  status: ApprovalStatus;
  requestedAt: Date;
  decidedAt: Date | null;
  decidedBy: string | null;
};

export type SpendRow = { key: string; micros: number };

/** One refund the agent made, as billing reported it. */
export type AgentRefundRow = {
  refundId: string;
  tenantId: string;
  ticketId: string;
  amountCents: number;
  createdAt: Date;
};

export type MemoryRow = {
  id: string;
  tenantId: string;
  customerId: string;
  kind: "ticket_summary";
  sourceTicketId: string;
  content: unknown;
  createdAt: Date;
  expiresAt: Date;
};

export type AuditLogRow = {
  seq: number;
  tenantId: string;
  ticketId: string | null;
  at: Date;
  actor: string;
  event: string;
  detail: string;
  prevHash: string;
  hash: string;
};

/** The application database: who the tenants and customers are, and their tickets. */
export type AppDatabase = {
  tenants: TenantRow;
  customers: CustomerRow;
  tickets: TicketRow;
  ticketGrants: TicketGrantRow;
  grantAssertions: GrantAssertionRow;
  auditLog: AuditLogRow;
  agentRuns: AgentRunRow;
  approvals: ApprovalRow;
  spend: SpendRow;
  agentRefunds: AgentRefundRow;
  memories: MemoryRow;
};
