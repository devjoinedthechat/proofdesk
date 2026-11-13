import {
  type AgentState,
  checkResolution,
  hideIdempotencyKey,
  initialState,
  inspectNext,
  type McpToolDescriptor,
  modelStep,
  type NextCall,
  refundsMade,
  type Screening,
  settleNext,
  systemPrompt,
  type ToolOutcome,
  ticketMessage,
  withIdempotencyKey,
} from "@proofdesk/agent";
import { type AppDatabase, appendAudit, type TicketStatus, withRowScope } from "@proofdesk/db";
import type { Effort, ModelProvider } from "@proofdesk/gateway";
import {
  type InvoiceRecords,
  type PolicyInputs,
  policyAuthorizer,
  refundRequest,
  type ToolPolicy,
} from "@proofdesk/policy";
import type { Kysely } from "kysely";

/** Identifiers only. This is all that ever travels through the workflow engine. */
export type TicketRef = { ticketId: string; tenantId: string; customerId: string };

export type TurnOutput = { pending: number; stopped: boolean };

export type CallOutput =
  | { status: "done"; pending: number; stopped: boolean }
  | { status: "needs_approval"; approvalId: string };

export type ApprovalAnswer = { decision: "approved" | "rejected"; decidedBy: string };

export type FinishOutput = { outcome: string; reasonCode: string };

/** The versions a run is pinned to, recorded on the run and in the audit log. */
export type Versions = { model: string; prompt: string; policy: string };

export type ActivityDeps = {
  /** Connection as `worker_app`. Every transaction is scoped to one ticket's tenant and customer. */
  db: Kysely<AppDatabase>;
  gateway: ModelProvider;
  versions: Versions;
  effort?: Effort;
  policy: ToolPolicy;
  /** The agent's tools for a ticket, reached with a fresh token per call. */
  tools: {
    list(ref: TicketRef): Promise<McpToolDescriptor[]>;
    call(
      ref: TicketRef,
      tool: McpToolDescriptor,
      input: Record<string, unknown>,
    ): Promise<ToolOutcome>;
  };
  /** The customer's invoices, read by the policy layer itself to judge a refund. */
  invoices(ref: TicketRef): Promise<InvoiceRecords>;
  /**
   * An optional first look at the ticket for signs of manipulation. Its
   * result is recorded for staff and metrics; it never decides anything.
   */
  screen?: (ref: TicketRef, ticket: { subject: string; body: string }) => Promise<Screening | null>;
  /** The kill switch, read at the moment of each tool call. */
  agentPaused?: (tenantId: string) => boolean | Promise<boolean>;
  clock: () => Date;
};

const TICKET_STATUS: Record<string, TicketStatus> = {
  refunded: "resolved",
  refused: "refused",
  needs_clarification: "waiting_customer",
  handed_to_staff: "handed_to_staff",
};

const HANDOVER_REPLY = "I have passed your request to our team, who will reply to you directly.";

export function createActivities(deps: ActivityDeps) {
  const scope = (ref: TicketRef) => ({ tenantId: ref.tenantId, customerId: ref.customerId });
  const audit = (ref: TicketRef, event: string, detail: Record<string, unknown>) =>
    appendAudit(deps.db, {
      tenantId: ref.tenantId,
      ticketId: ref.ticketId,
      at: deps.clock(),
      actor: "agent",
      event,
      detail,
    });

  async function load(ref: TicketRef) {
    const row = await withRowScope(deps.db, scope(ref), (trx) =>
      trx
        .selectFrom("agentRuns")
        .selectAll()
        .where("ticketId", "=", ref.ticketId)
        .executeTakeFirst(),
    );
    if (!row) throw new Error(`No agent run exists for ticket ${ref.ticketId}`);
    return {
      step: row.step,
      state: row.state as AgentState,
      tools: row.tools as McpToolDescriptor[],
      lastOutput: row.lastOutput,
    };
  }

  /**
   * Applies one step to a run exactly once. Activities can be retried after
   * they did their work but before the engine heard about it. The run's step
   * counter tells such a retry that the step is already applied, and it gets
   * the saved output instead of doing the work again.
   */
  async function advance<Output>(
    ref: TicketRef,
    step: number,
    apply: (state: AgentState, tools: McpToolDescriptor[]) => Promise<Output | { hold: Output }>,
  ): Promise<Output> {
    const run = await load(ref);
    // Already applied: skip the work. The conditional update below is what
    // guarantees correctness; this only saves a model or tool call.
    if (run.step > step) return run.lastOutput as Output;
    if (run.step < step) throw new Error(`Step ${step} arrived before step ${run.step} finished`);

    const result = await apply(run.state, run.tools);
    // A step that must wait for a person changes nothing and is not counted.
    if (result !== null && typeof result === "object" && "hold" in result) return result.hold;

    const saved = await withRowScope(deps.db, scope(ref), (trx) =>
      trx
        .updateTable("agentRuns")
        .set({
          state: JSON.stringify(run.state),
          step: step + 1,
          lastOutput: JSON.stringify(result),
          updatedAt: deps.clock(),
        })
        .where("ticketId", "=", ref.ticketId)
        .where("step", "=", step)
        .returning("step")
        .executeTakeFirst(),
    );
    // Another attempt of this same step saved first. Its output is the one that counts.
    return saved ? result : ((await load(ref)).lastOutput as Output);
  }

  async function tenantFacts(ref: TicketRef) {
    return withRowScope(deps.db, scope(ref), async (trx) => {
      const ticket = await trx
        .selectFrom("tickets")
        .selectAll()
        .where("id", "=", ref.ticketId)
        .executeTakeFirstOrThrow();
      const tenant = await trx
        .selectFrom("tenants")
        .selectAll()
        .where("id", "=", ref.tenantId)
        .executeTakeFirstOrThrow();
      return { ticket, tenant };
    });
  }

  return {
    /** Creates the run for a ticket. Safe to repeat: an existing run is left alone. */
    async startRun(ref: TicketRef): Promise<void> {
      const { ticket } = await tenantFacts(ref);
      const tools = await deps.tools.list(ref);
      const now = deps.clock();
      const state = initialState(
        ticketMessage({ now: ticket.createdAt, subject: ticket.subject, body: ticket.body }),
      );
      const created = await withRowScope(deps.db, scope(ref), (trx) =>
        trx
          .insertInto("agentRuns")
          .values({
            ...ref,
            step: 0,
            state: JSON.stringify(state),
            tools: JSON.stringify(tools),
            lastOutput: null,
            versions: JSON.stringify(deps.versions),
            createdAt: now,
            updatedAt: now,
          })
          .onConflict((conflict) => conflict.column("ticketId").doNothing())
          .returning("ticketId")
          .executeTakeFirst(),
      );
      if (created) {
        await audit(ref, "run_started", {
          category: ticket.category,
          tools: tools.map((tool) => tool.definition.name),
          ...deps.versions,
        });
        if (deps.screen) {
          // A screen that fails must not hold up the ticket.
          const screening = await deps.screen(ref, ticket).catch(() => null);
          await audit(ref, "ticket_screened", screening ?? { screened: false });
        }
      }
    },

    /** One model call. */
    async modelTurn(input: { ref: TicketRef; step: number }): Promise<TurnOutput> {
      const { ref } = input;
      const { tenant } = await tenantFacts(ref);
      return advance(ref, input.step, async (state, tools) => {
        await modelStep(state, {
          model: deps.versions.model,
          gateway: deps.gateway,
          context: { tenantId: ref.tenantId, ticketId: ref.ticketId },
          system: systemPrompt({
            tenantName: tenant.name,
            currency: tenant.currency,
            refundWindowDays: tenant.refundWindowDays,
            refundApprovalLimitCents: tenant.refundApprovalLimitCents,
          }),
          tools: tools.map((tool) => hideIdempotencyKey(tool.definition)),
          ...(deps.effort ? { effort: deps.effort } : {}),
        });
        return { pending: state.pending.length, stopped: state.stopped !== undefined };
      });
    },

    /**
     * Settles the next tool call the model asked for: checks policy, runs the
     * tool if allowed, and records the outcome. When policy asks for a
     * person's approval and none is given yet, it records the request and
     * returns without changing the run.
     */
    async executeNext(input: {
      ref: TicketRef;
      step: number;
      approval?: ApprovalAnswer;
    }): Promise<CallOutput> {
      const { ref, step, approval } = input;
      const { ticket, tenant } = await tenantFacts(ref);
      const agentPaused = (await deps.agentPaused?.(ref.tenantId)) ?? false;
      const inputs: PolicyInputs = {
        ticket: {
          id: ticket.id,
          category: ticket.category,
          approvalLimitCents: tenant.refundApprovalLimitCents,
          refundWindowDays: tenant.refundWindowDays,
        },
        now: deps.clock,
        invoices: () => deps.invoices(ref),
        agentPaused: () => agentPaused,
      };
      const approvalId = `${ref.ticketId}:${step}`;

      return advance<CallOutput>(ref, step, async (state, tools) => {
        const byName = new Map(tools.map((tool) => [tool.definition.name, tool]));
        let next: NextCall = await inspectNext(
          state,
          (name) => byName.has(name),
          policyAuthorizer(deps.policy, inputs),
        );

        if (next.kind === "tool" && next.verdict.decision === "needs_approval") {
          const summary = { tool: next.tool, ...next.input };
          if (!approval) {
            const requested = await withRowScope(deps.db, scope(ref), async (trx) => {
              await trx
                .updateTable("tickets")
                .set({ status: "waiting_approval" })
                .where("id", "=", ref.ticketId)
                .execute();
              return trx
                .insertInto("approvals")
                .values({
                  id: approvalId,
                  ...ref,
                  step,
                  tool: next.kind === "tool" ? next.tool : "",
                  summary: JSON.stringify(summary),
                  reason:
                    next.kind === "tool" && next.verdict.decision === "needs_approval"
                      ? next.verdict.reason
                      : "",
                  status: "pending",
                  requestedAt: deps.clock(),
                  decidedAt: null,
                  decidedBy: null,
                })
                .onConflict((conflict) => conflict.column("id").doNothing())
                .returning("id")
                .executeTakeFirst();
            });
            if (requested) await audit(ref, "approval_requested", { approvalId, ...summary });
            return { hold: { status: "needs_approval", approvalId } };
          }

          await withRowScope(deps.db, scope(ref), async (trx) => {
            await trx
              .updateTable("approvals")
              .set({
                status: approval.decision,
                decidedAt: deps.clock(),
                decidedBy: approval.decidedBy,
              })
              .where("id", "=", approvalId)
              .where("status", "=", "pending")
              .execute();
            await trx
              .updateTable("tickets")
              .set({ status: "open" })
              .where("id", "=", ref.ticketId)
              .execute();
          });
          await audit(ref, "approval_decided", { approvalId, ...approval });

          // An approval lets policy be asked again, this time with the
          // approval as a fact. It cannot override a rule that forbids the
          // call outright, such as the kill switch.
          if (approval.decision === "approved") {
            const refunded = refundsMade(state.toolCalls).reduce(
              (sum, refund) => sum + refund.amountCents,
              0,
            );
            const recheck = deps.policy.decide(
              await refundRequest(inputs, next.input, refunded, true),
            );
            if (recheck.decision !== "allow") {
              next = { ...next, verdict: { decision: "deny", reason: recheck.reason } };
            }
          }
        }

        const before = state.toolCalls.length;
        await settleNext(
          state,
          next,
          async (name, toolInput) => {
            const tool = byName.get(name);
            if (!tool) return { content: `Unknown tool "${name}".`, isError: true };
            return deps.tools.call(ref, tool, withIdempotencyKey(ref.ticketId, name, toolInput));
          },
          approval?.decision,
        );

        const record = state.toolCalls[before];
        if (record) {
          await audit(ref, "tool_call", {
            step,
            tool: record.tool,
            verdict: record.verdict,
            failed: record.outcome.isError,
            // Arguments are identifiers and amounts. Results may hold more, so they stay out.
            input: record.input,
          });
        }
        return {
          status: "done",
          pending: state.pending.length,
          stopped: state.stopped !== undefined,
        };
      });
    },

    /**
     * Ends the run: checks the model's account of its work against what the
     * tools reported, then writes the outcome and the reply to the ticket.
     */
    async finishRun(ref: TicketRef): Promise<FinishOutput> {
      const run = await load(ref);
      const { state } = run;
      const violations = state.resolution ? checkResolution(state.resolution, state.toolCalls) : [];

      const final =
        state.resolution && violations.length === 0
          ? state.resolution
          : {
              outcome: "handed_to_staff",
              reasonCode: state.resolution
                ? `guard_${violations[0]}`
                : `agent_${state.stopped ?? "unfinished"}`,
              reply: HANDOVER_REPLY,
            };

      const updated = await withRowScope(deps.db, scope(ref), (trx) =>
        trx
          .updateTable("tickets")
          .set({
            status: TICKET_STATUS[final.outcome] ?? "handed_to_staff",
            outcome: final.outcome,
            reasonCode: final.reasonCode,
            reply: final.reply,
            resolvedAt: deps.clock(),
          })
          .where("id", "=", ref.ticketId)
          .where("outcome", "is", null)
          .returning("id")
          .executeTakeFirst(),
      );
      if (updated) {
        await audit(ref, "run_finished", {
          outcome: final.outcome,
          reasonCode: final.reasonCode,
          turns: state.turns,
          toolCalls: state.toolCalls.length,
          refundedCents: refundsMade(state.toolCalls).reduce(
            (sum, refund) => sum + refund.amountCents,
            0,
          ),
          violations,
        });
      }
      return { outcome: final.outcome, reasonCode: final.reasonCode };
    },
  };
}

export type Activities = ReturnType<typeof createActivities>;
