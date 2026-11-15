import type { ColumnType, Generated } from "kysely";

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

/** What a model call under way has set aside in one budget. */
export type SpendReservationRow = { id: string; key: string; micros: number; expiresAt: Date };

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

/** Which build handles a ticket. */
export type TicketRoute = "stable" | "canary";

/** The tickets table as stored: a ticket plus the build it was sent to. */
export type TicketTable = TicketRow & {
  route: ColumnType<TicketRoute, TicketRoute | undefined, TicketRoute>;
};

/** How new tickets are divided between the stable build and a canary. One row. */
export type RolloutRow = {
  id: "agent";
  canaryShare: number;
  canaryVersion: string | null;
  reason: string;
  setBy: string;
  setAt: Date;
};

/** Something the watchdog did, or wants a person to look at. Counts only. */
export type AlertRow = {
  id: Generated<number>;
  kind: string;
  tenantId: string | null;
  detail: unknown;
  raisedBy: string;
  raisedAt: Date;
};

/** One message in a ticket's conversation after the first. */
export type TicketMessageRow = {
  id: string;
  /** The order messages were written in. Set by the database. */
  seq: Generated<number>;
  ticketId: string;
  tenantId: string;
  customerId: string;
  author: "customer" | "agent" | "staff";
  body: string;
  createdAt: Date;
};

export type OutboxKind = "ticket" | "follow_up" | "deletion";

/** Work promised to the workflow engine and not yet handed over. */
export type WorkflowOutboxRow = {
  id: string;
  kind: OutboxKind;
  tenantId: string;
  customerId: string;
  ticketId: string;
  /** What the workflow is started with: identifiers only. */
  payload: unknown;
  createdAt: Date;
  startedAt: Date | null;
};

/** A member of staff's verdict on a ticket the agent handed over. */
export type TicketReviewRow = {
  ticketId: string;
  tenantId: string;
  verdict: "agent_right" | "agent_wrong";
  expectedOutcome: string;
  expectedReason: string;
  /** Payment ids and amounts: `{ paymentId, amountCents }[]`. */
  expectedRefunds: unknown;
  reviewedBy: string;
  reviewedAt: Date;
};

/** One setting of the kill switch: the whole agent, or one tool, for a tenant. */
export type AgentControlRow = {
  tenantId: string;
  /** `agent`, or `tool:<name>`. */
  scope: string;
  paused: boolean;
  reason: string;
  setBy: string;
  setAt: Date;
};

/** A customer's request to be deleted, and the record that it was done. */
export type DeletionRequestRow = {
  id: string;
  tenantId: string;
  customerId: string;
  ticketId: string;
  status: "requested" | "completed";
  requestedAt: Date;
  completedAt: Date | null;
  /** Rows removed per table. No content. */
  erased: unknown;
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
  tickets: TicketTable;
  ticketGrants: TicketGrantRow;
  grantAssertions: GrantAssertionRow;
  auditLog: AuditLogRow;
  agentRuns: AgentRunRow;
  approvals: ApprovalRow;
  spend: SpendRow;
  spendReservations: SpendReservationRow;
  agentRefunds: AgentRefundRow;
  deletionRequests: DeletionRequestRow;
  agentControls: AgentControlRow;
  ticketReviews: TicketReviewRow;
  ticketMessages: TicketMessageRow;
  workflowOutbox: WorkflowOutboxRow;
  rollout: RolloutRow;
  alerts: AlertRow;
  memories: MemoryRow;
};
