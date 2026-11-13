import {
  type AgentResult,
  type AgentTool,
  checkResolution,
  runAgent,
  systemPrompt,
  type TenantPolicy,
  ticketMessage,
  withSystemIdempotency,
} from "@proofdesk/agent";
import type { Effort, ModelProvider } from "@proofdesk/gateway";
import { BILLING_TOOLS } from "@proofdesk/mcp-billing";
import { createToolPolicy, policyAuthorizer, type ToolPolicy } from "@proofdesk/policy";
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

const productionPolicy = createToolPolicy();

export type AgentSolverOptions = {
  gateway: ModelProvider;
  model: string;
  effort?: Effort;
  maxTurns?: number;
  /** The policy set to enforce. Defaults to the production policies. */
  policy?: ToolPolicy;
  /** Builds the system prompt. Defaults to the production prompt. */
  system?: (policy: TenantPolicy) => string;
  /** Called with the full result of each run, for metrics. */
  onResult?: (result: AgentResult, violations: string[]) => void;
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
      system: (options.system ?? systemPrompt)({
        tenantName: tenant.name,
        currency: tenant.currency,
        refundWindowDays: tenant.refundWindowDays,
        refundApprovalLimitCents: tenant.refundApprovalLimitCents,
      }),
      ticket: ticketMessage({ now: context.now, subject: ticket.subject, body: ticket.body }),
      tools: tools.map((tool) => withSystemIdempotency(tool, ticket.id)),
      authorize: policyAuthorizer(options.policy ?? productionPolicy, {
        ticket: {
          id: ticket.id,
          category: ticket.category,
          approvalLimitCents: tenant.refundApprovalLimitCents,
          refundWindowDays: tenant.refundWindowDays,
        },
        now: () => context.now,
        // The policy layer reads the records itself, on its own connection.
        invoices: () => context.billing.listInvoices(context.customer.id),
      }),
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
    const violations = result.resolution
      ? checkResolution(result.resolution, result.toolCalls)
      : [];
    options.onResult?.(result, violations);
    if (!result.resolution) return handOver(`agent_${result.stopped}`);
    return violations[0] ? handOver(`guard_${violations[0]}`) : result.resolution;
  };
}
