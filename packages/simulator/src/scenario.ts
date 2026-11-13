import type { BillingClient } from "@proofdesk/billing";
import type { CustomerRow, TenantRow, TicketRow } from "@proofdesk/db";
import type { EntitlementsClient } from "@proofdesk/entitlements";
import { ScenarioBuilder } from "./builder.ts";
import type { PlannedRefund, ReasonCode, RefundIntent } from "./refund-policy.ts";
import type { World } from "./world.ts";

export type Outcome = "refunded" | "refused" | "needs_clarification" | "handed_to_staff";

/** The known correct result of a scenario, written by hand. */
export type Expected = {
  outcome: Outcome;
  reasonCode: ReasonCode;
  /** Exactly the refunds that must exist afterwards. Anything else is a failure. */
  refunds: { paymentId: string; amountCents: number }[];
  /** Present when staff approval must be requested, for this total. */
  approval?: { amountCents: number };
  reply: {
    /** Facts the reply must state, matched as case-insensitive text. */
    mentions: string[];
    /** Text the reply must not contain, such as another customer's details. */
    mustNotMention?: string[];
  };
};

export type ScenarioCase = {
  customer: CustomerRow;
  ticket: TicketRow;
  /** The ticket's meaning in structured form. Only the oracle may read it. */
  intent: RefundIntent;
  /** How staff answer an approval request in this scenario. */
  staffDecision?: "approved" | "rejected";
  expected: Expected;
};

export type ScenarioSpec = {
  id: string;
  title: string;
  build(builder: ScenarioBuilder): ScenarioCase;
};

export type Scenario = ScenarioCase & {
  id: string;
  title: string;
  tenant: TenantRow;
  /** The rows this scenario adds to the background company. */
  added: World;
};

export function materialise(spec: ScenarioSpec, base: World): Scenario {
  const builder = new ScenarioBuilder(base, spec.id);
  const built = spec.build(builder);
  const tenant = base.tenants.find((candidate) => candidate.id === built.customer.tenantId);
  if (!tenant) throw new Error(`Scenario ${spec.id} uses an unknown tenant`);
  return { id: spec.id, title: spec.title, tenant, added: builder.added, ...built };
}

export type ApprovalRequest = { refunds: PlannedRefund[]; totalCents: number };

/** Everything a solver may use. It mirrors what the agent will be given. */
export type SolverContext = {
  now: Date;
  tenant: TenantRow;
  customer: CustomerRow;
  ticket: TicketRow;
  billing: BillingClient;
  entitlements: EntitlementsClient;
  requestApproval(request: ApprovalRequest): Promise<"approved" | "rejected">;
};

export type SolverResult = { outcome: Outcome; reasonCode: ReasonCode; reply: string };

/** Anything that resolves a ticket: the scripted oracle now, the agent later. */
export type Solver = (context: SolverContext) => Promise<SolverResult>;
