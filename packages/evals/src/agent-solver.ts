import {
  type AgentTool,
  type Authorize,
  checkResolution,
  refundsMade,
  runAgent,
  systemPrompt,
  ticketMessage,
  withSystemIdempotency,
} from "@proofdesk/agent";
import type { Effort, ModelProvider } from "@proofdesk/gateway";
import { BILLING_TOOLS } from "@proofdesk/mcp-billing";
import { ServiceApiError } from "@proofdesk/service";
import type { Solver, SolverContext } from "@proofdesk/simulator";
import { z } from "zod";

/** The billing tools, called on the simulation's billing client without the MCP hop. */
export function directBillingTools(context: SolverContext): AgentTool[] {
  return BILLING_TOOLS.map((tool) => ({
    definition: {
      name: tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.input) as Record<string, unknown>,
    },
    writes: tool.writes,
    async call(input) {
      try {
        const result = await tool.run(context.billing, context.customer.id, input);
        return { content: JSON.stringify(result), isError: false };
      } catch (error) {
        const failure =
          error instanceof ServiceApiError
            ? { code: error.code, message: error.message }
            : error instanceof z.ZodError
              ? { code: "invalid_input", message: error.issues[0]?.message ?? "invalid" }
              : null;
        if (!failure) throw error;
        return { content: JSON.stringify({ error: failure }), isError: true };
      }
    },
  }));
}

/**
 * The approval rule in plain code: a ticket's refunds may total at most the
 * tenant's limit without a person agreeing. The worker enforces the same rule
 * through the policy engine; this version exists so evaluations do not need it.
 */
export function approvalLimit(limitCents: number): Authorize {
  return (call, history) => {
    if (call.tool !== "create_refund") return { decision: "allow" };
    const amount = call.input.amountCents;
    if (typeof amount !== "number") return { decision: "allow" };
    const already = refundsMade(history).reduce((sum, refund) => sum + refund.amountCents, 0);
    return already + amount > limitCents
      ? {
          decision: "needs_approval",
          reason: "The refund total for this ticket is above the approval limit.",
        }
      : { decision: "allow" };
  };
}

export type AgentSolverOptions = {
  gateway: ModelProvider;
  model: string;
  effort?: Effort;
  maxTurns?: number;
  /** Where the agent's tools come from. Defaults to the simulation's billing client. */
  tools?: (context: SolverContext) => Promise<AgentTool[]> | AgentTool[];
};

/**
 * Wraps the agent as a scenario solver, so it is judged exactly like the
 * oracle: on the final state of the company. A run that does not end in a
 * clean, self-consistent resolution counts as handed to staff, which is what
 * the workflow does with it.
 */
export function createAgentSolver(options: AgentSolverOptions): Solver {
  return async (context) => {
    const { tenant, ticket } = context;
    const tools = await (options.tools ?? directBillingTools)(context);

    const result = await runAgent({
      model: options.model,
      gateway: options.gateway,
      context: { tenantId: tenant.id, ticketId: ticket.id },
      system: systemPrompt({
        tenantName: tenant.name,
        currency: tenant.currency,
        refundWindowDays: tenant.refundWindowDays,
        refundApprovalLimitCents: tenant.refundApprovalLimitCents,
      }),
      ticket: ticketMessage({ now: context.now, subject: ticket.subject, body: ticket.body }),
      tools: tools.map((tool) => withSystemIdempotency(tool, ticket.id)),
      authorize: approvalLimit(tenant.refundApprovalLimitCents),
      requestApproval: (call) => {
        const amountCents = Number(call.input.amountCents);
        return context.requestApproval({
          refunds: [
            {
              paymentId: String(call.input.paymentId),
              amountCents,
              reason: call.input.reason as
                | "duplicate_charge"
                | "customer_request"
                | "service_credit",
            },
          ],
          totalCents: amountCents,
        });
      },
      ...(options.effort ? { effort: options.effort } : {}),
      ...(options.maxTurns ? { maxTurns: options.maxTurns } : {}),
    });

    const handOver = (reasonCode: string) => ({
      outcome: "handed_to_staff" as const,
      reasonCode,
      reply: "I have passed your request to our team, who will reply to you directly.",
    });
    if (!result.resolution) return handOver(`agent_${result.stopped}`);
    const [violation] = checkResolution(result.resolution, result.toolCalls);
    return violation ? handOver(`guard_${violation}`) : result.resolution;
  };
}
