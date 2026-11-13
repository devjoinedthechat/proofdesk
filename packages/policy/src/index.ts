import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as cedar from "@cedar-policy/cedar-wasm/nodejs";
import { type Authorize, refundsMade } from "@proofdesk/agent";
import { type InvoiceRecords, type RefundFacts, refundFacts } from "./facts.ts";

export { type InvoiceRecords, invoiceRecords, type RefundFacts, refundFacts } from "./facts.ts";

const POLICY_DIR = fileURLToPath(new URL("../policies", import.meta.url));

/**
 * The refund rules that are enforced on facts from the billing records.
 * Leaving them out gives the weaker configuration in which those rules exist
 * only in the model's prompt. That configuration is for measuring what the
 * enforcement is worth, never for production.
 */
export const RECORD_BASED_POLICIES = [
  "refund-unknown-payment",
  "refund-disputed",
  "refund-outside-window",
  "refund-not-duplicate",
  "refund-goodwill-used",
  "refund-large-payment",
  "refund-tenant-daily-cap",
];

/** The policies as shipped: one file per policy, named by the file. */
export function loadPolicies(options: { directory?: string; exclude?: string[] } = {}) {
  const directory = options.directory ?? POLICY_DIR;
  const policies: Record<string, string> = {};
  for (const file of readdirSync(directory).sort()) {
    const id = file.replace(/\.cedar$/, "");
    if (file.endsWith(".cedar") && !options.exclude?.includes(id)) {
      policies[id] = readFileSync(`${directory}/${file}`, "utf8");
    }
  }
  return { schema: readFileSync(`${directory}/schema.cedarschema`, "utf8"), policies };
}

export type PolicySet = ReturnType<typeof loadPolicies>;

/** Checks the policies against the schema. Returns one message per problem. */
export function validatePolicies(set: PolicySet = loadPolicies()): string[] {
  const answer = cedar.validate({ schema: set.schema, policies: { staticPolicies: set.policies } });
  if (answer.type === "failure") return answer.errors.map((error) => error.message);
  return answer.validationErrors.map((error) => `${error.policyId}: ${error.error.message}`);
}

export type TicketFacts = {
  id: string;
  category: string;
  approvalLimitCents: number;
  refundWindowDays: number;
  /** The tenant's cap on the agent's refunds in 24 hours. Absent means no cap. */
  dailyRefundCapCents?: number;
};

/** Stands for "no cap" where a number is required. Far above any real total. */
const NO_CAP_CENTS = 1_000_000_000_000;

export type ToolRequest = {
  tool: string;
  ticket: TicketFacts;
  agentPaused: boolean;
  /** For create_refund. */
  refund?: {
    amountCents: number;
    reason: string;
    ticketRefundedCents: number;
    /** What the agent has refunded for the tenant in the last 24 hours. */
    tenantRefundedTodayCents?: number;
    approved: boolean;
    facts: RefundFacts;
  };
  /** For change_plan. */
  planChange?: { seats: number };
};

export type PolicyDecision = {
  decision: "allow" | "deny" | "needs_approval";
  /** The policies that decided. Empty when nothing permitted the call. */
  policies: string[];
  reason: string;
};

const REFUND = "create_refund";
const CHANGE_PLAN = "change_plan";

/** What the model is told when a policy forbids its call, so it can explain the refusal. */
const FORBIDDEN_BECAUSE: Record<string, string> = {
  "agent-paused": "The agent is paused for this company.",
  "refund-unknown-payment": "That payment is not on this customer's account.",
  "refund-disputed": "A payment on this invoice is under a bank dispute; staff must handle it.",
  "refund-outside-window": "The payment is older than the refund window.",
  "refund-not-duplicate":
    "That payment is not a duplicate: no earlier successful payment exists for the invoice.",
  "refund-goodwill-used": "The customer already had a refund on request in the last 12 months.",
  "plan-change-seat-limit": "More than 50 seats must be arranged by staff.",
  "refund-over-limit": "The refund total for this ticket is above the approval limit.",
  "refund-large-payment":
    "The payment is larger than the approval limit, so any refund against it needs approval.",
  "refund-tenant-daily-cap":
    "The daily total of refunds made without staff has been reached, so this refund needs approval.",
};

/**
 * Decides tool calls with Cedar. A call is allowed only if some policy
 * permits it and none forbids it, so anything the policies do not mention is
 * denied, including a tool nobody wrote a policy for.
 */
export function createToolPolicy(set: PolicySet = loadPolicies()) {
  const problems = validatePolicies(set);
  if (problems.length > 0) throw new Error(`Invalid policies:\n${problems.join("\n")}`);

  function evaluate(request: ToolRequest, approved: boolean) {
    const context: Record<string, cedar.CedarValueJson> = { agentPaused: request.agentPaused };
    if (request.tool === REFUND && request.refund) {
      const { facts, ...refund } = request.refund;
      Object.assign(context, {
        tenantRefundedTodayCents: 0,
        ...refund,
        ...facts,
        approved,
      });
    }
    if (request.tool === CHANGE_PLAN && request.planChange)
      context.seats = request.planChange.seats;
    const answer = cedar.isAuthorized({
      principal: { type: "Agent", id: "agent-worker" },
      action: { type: "Action", id: request.tool },
      resource: { type: "Ticket", id: request.ticket.id },
      context,
      schema: set.schema,
      validateRequest: true,
      policies: { staticPolicies: set.policies },
      entities: [
        {
          uid: { type: "Ticket", id: request.ticket.id },
          attrs: {
            category: request.ticket.category,
            approvalLimitCents: request.ticket.approvalLimitCents,
            refundWindowDays: request.ticket.refundWindowDays,
            dailyRefundCapCents: request.ticket.dailyRefundCapCents ?? NO_CAP_CENTS,
          },
          parents: [],
        },
        { uid: { type: "Agent", id: "agent-worker" }, attrs: {}, parents: [] },
      ],
    });
    // A request Cedar cannot evaluate, such as an unknown tool, is denied.
    if (answer.type === "failure") return { allowed: false, policies: [] as string[] };
    if (answer.response.diagnostics.errors.length > 0) return { allowed: false, policies: [] };
    return {
      allowed: answer.response.decision === "allow",
      policies: [...answer.response.diagnostics.reason].sort(),
    };
  }

  return {
    decide(request: ToolRequest): PolicyDecision {
      const refund = request.tool === REFUND ? request.refund : undefined;
      if (
        request.tool === REFUND &&
        (!refund ||
          !Number.isSafeInteger(refund.amountCents) ||
          !Number.isSafeInteger(refund.ticketRefundedCents) ||
          typeof refund.reason !== "string")
      ) {
        return { decision: "deny", policies: [], reason: "The refund request is malformed." };
      }

      if (request.tool === CHANGE_PLAN && !Number.isSafeInteger(request.planChange?.seats)) {
        return {
          decision: "deny",
          policies: [],
          reason: "The number of seats must be a whole number.",
        };
      }

      const actual = evaluate(request, refund?.approved === true);
      if (actual.allowed) {
        return { decision: "allow", policies: actual.policies, reason: "Permitted." };
      }
      // Would a person's approval change the answer? If so, ask for it.
      // Approval only lifts the amount limit; every other rule still applies.
      if (refund && !refund.approved) {
        const withApproval = evaluate(request, true);
        if (withApproval.allowed) {
          // Everything that forbade the call was a rule approval can lift.
          return {
            decision: "needs_approval",
            policies: actual.policies,
            reason: actual.policies.map((id) => FORBIDDEN_BECAUSE[id] ?? id).join(" "),
          };
        }
      }
      const reasons = actual.policies.map((id) => FORBIDDEN_BECAUSE[id] ?? `Forbidden by ${id}.`);
      return {
        decision: "deny",
        policies: actual.policies,
        reason: reasons.length > 0 ? reasons.join(" ") : "No policy permits this action.",
      };
    },
  };
}

export type ToolPolicy = ReturnType<typeof createToolPolicy>;

export type PolicyInputs = {
  ticket: TicketFacts;
  now: () => Date;
  /** The customer's invoices, fetched from billing by the caller, not supplied by the model. */
  invoices: () => Promise<InvoiceRecords>;
  agentPaused?: () => boolean;
  /** What the agent has refunded for this tenant in the last 24 hours, from the system's record. */
  tenantRefundedToday?: () => Promise<number>;
};

/** Builds the policy request for one refund call from trusted inputs. */
export async function refundRequest(
  inputs: PolicyInputs,
  input: Record<string, unknown>,
  ticketRefundedCents: number,
  approved: boolean,
): Promise<ToolRequest> {
  return {
    tool: REFUND,
    ticket: inputs.ticket,
    agentPaused: inputs.agentPaused?.() ?? false,
    refund: {
      amountCents: input.amountCents as number,
      reason: input.reason as string,
      ticketRefundedCents,
      tenantRefundedTodayCents: (await inputs.tenantRefundedToday?.()) ?? 0,
      approved,
      facts: refundFacts(await inputs.invoices(), String(input.paymentId), inputs.now()),
    },
  };
}

/**
 * Adapts the policy to the agent loop. What the ticket has refunded so far is
 * taken from the run's own tool results, and the facts about the payment from
 * the billing records. Nothing the policy relies on comes from the model.
 */
export function policyAuthorizer(policy: ToolPolicy, inputs: PolicyInputs): Authorize {
  return async (call, history) => {
    const refunded = refundsMade(history).reduce((sum, refund) => sum + refund.amountCents, 0);
    const base = {
      tool: call.tool,
      ticket: inputs.ticket,
      agentPaused: inputs.agentPaused?.() ?? false,
    };
    const request: ToolRequest =
      call.tool === REFUND
        ? await refundRequest(inputs, call.input, refunded, false)
        : call.tool === CHANGE_PLAN
          ? { ...base, planChange: { seats: call.input.seats as number } }
          : base;
    const result = policy.decide(request);
    return result.decision === "allow"
      ? { decision: "allow" }
      : { decision: result.decision, reason: result.reason };
  };
}
