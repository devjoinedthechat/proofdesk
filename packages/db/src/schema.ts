export type TicketStatus =
  | "open"
  | "waiting_approval"
  | "waiting_customer"
  | "handed_to_staff"
  | "resolved"
  | "refused";

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
  subject: string;
  body: string;
  status: TicketStatus;
  createdAt: Date;
};

/** The application database: who the tenants and customers are, and their tickets. */
export type AppDatabase = {
  tenants: TenantRow;
  customers: CustomerRow;
  tickets: TicketRow;
};
