import {
  type AgentResult,
  type AgentTool,
  checkResolution,
  runAgent,
  systemPrompt,
  type TenantPolicy,
  ticketMessage,
  withPlanChange,
  withSystemIdempotency,
} from "@proofdesk/agent";
import type { Effort, ModelProvider } from "@proofdesk/gateway";
import { BILLING_TOOLS } from "@proofdesk/mcp-billing";
import { SEARCH_TOOL, toToolResult } from "@proofdesk/mcp-documents";
import { ENTITLEMENTS_TOOLS } from "@proofdesk/mcp-entitlements";
import type { ServiceTool } from "@proofdesk/mcp-server";
import { createToolPolicy, policyAuthorizer, type ToolPolicy } from "@proofdesk/policy";
import { GRANT_SCOPES } from "@proofdesk/portal";
import { ServiceApiError } from "@proofdesk/service";
import type { Solver, SolverContext } from "@proofdesk/simulator";
import { z } from "zod";

const productionPolicy = createToolPolicy();

function direct<Client>(
  tools: ServiceTool<Client>[],
  client: Client,
  customerId: string,
): (AgentTool & { scope: string })[] {
  return tools.map((tool) => ({
    scope: tool.scope,
    definition: {
      name: tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.input) as Record<string, unknown>,
    },
    writes: tool.writes,
    async call(input) {
      try {
        return {
          content: JSON.stringify(await tool.run(client, customerId, input)),
          isError: false,
        };
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
 * The service tools, called on the simulation's clients without the MCP hop.
 * Only the tools the ticket's category grants are included, which is what
 * the token scopes do in production.
 */
export function directBillingTools(context: SolverContext): AgentTool[] {
  const granted = new Set(GRANT_SCOPES[context.ticket.category]);
  return [
    ...direct(BILLING_TOOLS, context.billing, context.customer.id),
    ...direct(ENTITLEMENTS_TOOLS, context.entitlements, context.customer.id),
  ].filter((tool) => granted.has(tool.scope));
}

/** The help-centre search, called on the simulation's knowledge base without the MCP hop. */
export function directHelpCenterTool(context: SolverContext): AgentTool[] {
  const { helpCenter } = context;
  if (!helpCenter) return [];
  return [
    {
      definition: {
        name: SEARCH_TOOL.name,
        description: SEARCH_TOOL.description,
        inputSchema: z.toJSONSchema(SEARCH_TOOL.input) as Record<string, unknown>,
      },
      writes: false,
      async call(input) {
        const parsed = SEARCH_TOOL.input.safeParse(input);
        if (!parsed.success) {
          return { content: JSON.stringify({ error: { code: "invalid_input" } }), isError: true };
        }
        return {
          content: JSON.stringify(toToolResult(await helpCenter(parsed.data.query))),
          isError: false,
        };
      },
    },
  ];
}

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
    const tools = [
      ...(await (options.tools ?? directBillingTools)(context)),
      ...directHelpCenterTool(context),
    ];

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
      tools: withPlanChange(tools, ticket.id).map((tool) => withSystemIdempotency(tool, ticket.id)),
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
