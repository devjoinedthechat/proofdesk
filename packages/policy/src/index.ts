import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as cedar from "@cedar-policy/cedar-wasm/nodejs";
import { type Authorize, refundsMade } from "@proofdesk/agent";

const POLICY_DIR = fileURLToPath(new URL("../policies", import.meta.url));

/** The policies as shipped: one file per policy, named by the file. */
export function loadPolicies(directory: string = POLICY_DIR) {
  const policies: Record<string, string> = {};
  for (const file of readdirSync(directory).sort()) {
    if (file.endsWith(".cedar")) {
      policies[file.replace(/\.cedar$/, "")] = readFileSync(`${directory}/${file}`, "utf8");
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
};

export type ToolRequest = {
  tool: string;
  ticket: TicketFacts;
  agentPaused: boolean;
  /** For create_refund. */
  amountCents?: number;
  ticketRefundedCents?: number;
  approved?: boolean;
};

export type PolicyDecision = {
  decision: "allow" | "deny" | "needs_approval";
  /** The policies that decided. Empty when nothing permitted the call. */
  policies: string[];
  reason: string;
};

const REFUND = "create_refund";

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
    if (request.tool === REFUND) {
      context.amountCents = request.amountCents ?? 0;
      context.ticketRefundedCents = request.ticketRefundedCents ?? 0;
      context.approved = approved;
    }
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
      if (
        request.tool === REFUND &&
        (!Number.isSafeInteger(request.amountCents) ||
          !Number.isSafeInteger(request.ticketRefundedCents ?? 0))
      ) {
        return {
          decision: "deny",
          policies: [],
          reason: "The refund amount is not a whole number of cents.",
        };
      }

      const actual = evaluate(request, request.approved === true);
      if (actual.allowed) {
        return { decision: "allow", policies: actual.policies, reason: "Permitted." };
      }
      // Would a person's approval change the answer? If so, ask for it.
      if (request.tool === REFUND && request.approved !== true) {
        const withApproval = evaluate(request, true);
        if (withApproval.allowed) {
          return {
            decision: "needs_approval",
            policies: withApproval.policies,
            reason: "The refund total for this ticket is above the approval limit.",
          };
        }
      }
      return {
        decision: "deny",
        policies: actual.policies,
        reason:
          actual.policies.length > 0
            ? `Forbidden by ${actual.policies.join(", ")}.`
            : "No policy permits this action.",
      };
    },
  };
}

export type ToolPolicy = ReturnType<typeof createToolPolicy>;

/**
 * Adapts the policy to the agent loop. What the ticket has refunded so far is
 * taken from the run's own tool results, never from the model.
 */
export function policyAuthorizer(
  policy: ToolPolicy,
  facts: { ticket: TicketFacts; agentPaused?: () => boolean },
): Authorize {
  return (call, history) => {
    const refunded = refundsMade(history).reduce((sum, refund) => sum + refund.amountCents, 0);
    const result = policy.decide({
      tool: call.tool,
      ticket: facts.ticket,
      agentPaused: facts.agentPaused?.() ?? false,
      ...(call.tool === REFUND
        ? { amountCents: call.input.amountCents as number, ticketRefundedCents: refunded }
        : {}),
    });
    return result.decision === "allow"
      ? { decision: "allow" }
      : { decision: result.decision, reason: result.reason };
  };
}
