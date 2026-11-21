import { type AppDatabase, appendAudit, withRowScope } from "@proofdesk/db";
import type { Inspection, Telemetry } from "@proofdesk/telemetry";
import { type Kysely, sql } from "kysely";
import { z } from "zod";
import { recordEvent } from "./telemetry.ts";

/** One deletion request: the request itself, and the ticket whose grant authorises it. */
export type DeletionRef = {
  requestId: string;
  ticketId: string;
  tenantId: string;
  customerId: string;
};

/** How many records each store removed or changed. Counts only, never content. */
export type DeletionReport = {
  billing: { subscriptionsCanceled: number; referencesCleared: number };
  entitlements: { entitlements: number; writes: number };
  records: Record<string, number>;
  signInAccounts: number;
  /** Conversations removed from the inspection store. */
  conversations: number;
};

export type DeletionDeps = {
  /** Connection as `worker_app`. */
  db: Kysely<AppDatabase>;
  clock: () => Date;
  /**
   * The other systems, each reached with a token from the request's own
   * grant. The worker has no standing authority to erase anything.
   */
  billing: { closeAccount(ref: DeletionRef): Promise<DeletionReport["billing"]> };
  entitlements: { erase(ref: DeletionRef): Promise<DeletionReport["entitlements"]> };
  /** Removes the customer's sign-in account and returns how many were removed. */
  identity: { deleteAccount(customerId: string): Promise<number> };
  /** Which of the given ticket workflows are still running, by workflow id. */
  agents: { running(workflowIds: string[]): Promise<string[]> };
  telemetry?: Telemetry;
  /** The store of full conversations, if one is in use. A deletion must reach it. */
  inspection?: Inspection;
};

const billingClosed = z.object({
  closed: z.object({
    subscriptionsCanceled: z.number().int().nonnegative(),
    referencesCleared: z.number().int().nonnegative(),
  }),
});
const entitlementsErased = z.object({
  erased: z.object({
    entitlements: z.number().int().nonnegative(),
    writes: z.number().int().nonnegative(),
  }),
});

/**
 * Builds the two erasers from a way to call an MCP tool for the request's
 * ticket. A refused or malformed answer is an error: a deletion that did not
 * happen must never be reported as done.
 */
export function mcpErasers(
  call: (
    ref: DeletionRef,
    server: "billing" | "entitlements",
    tool: { name: string; scope: string },
  ) => Promise<{ content: string; isError: boolean }>,
  scopes: { billingErase: string; entitlementsErase: string },
): Pick<DeletionDeps, "billing" | "entitlements"> {
  async function run<Schema extends z.ZodType>(
    ref: DeletionRef,
    server: "billing" | "entitlements",
    tool: { name: string; scope: string },
    schema: Schema,
  ): Promise<z.infer<Schema>> {
    const outcome = await call(ref, server, tool);
    if (outcome.isError) throw new Error(`${tool.name} was refused: ${outcome.content}`);
    return schema.parse(JSON.parse(outcome.content));
  }
  return {
    billing: {
      closeAccount: async (ref) =>
        (
          await run(
            ref,
            "billing",
            { name: "close_account", scope: scopes.billingErase },
            billingClosed,
          )
        ).closed,
    },
    entitlements: {
      erase: async (ref) =>
        (
          await run(
            ref,
            "entitlements",
            { name: "erase_entitlement", scope: scopes.entitlementsErase },
            entitlementsErased,
          )
        ).erased,
    },
  };
}

/** How long one attempt waits for agents to stop. Well inside the activity's own timeout. */
const AGENT_WAIT_MS = 60_000;
const OPEN_STATUSES = ["open", "waiting_approval", "waiting_customer"] as const;
const erasedCounts = z.record(z.string(), z.number().int().nonnegative());

/**
 * The steps of a deletion. No model is involved at any point: what to delete
 * is fixed in code and in one database function, and a person's data is not
 * something to leave to judgment.
 *
 * Every step is safe to repeat. The engine may run any of them again.
 */
export function createDeletionActivities(deps: DeletionDeps) {
  const scope = (ref: DeletionRef) => ({ tenantId: ref.tenantId, customerId: ref.customerId });
  const audit = async (ref: DeletionRef, event: string, detail: Record<string, unknown>) => {
    await appendAudit(deps.db, {
      tenantId: ref.tenantId,
      ticketId: ref.ticketId,
      at: deps.clock(),
      actor: "system:deletion",
      event,
      detail: { requestId: ref.requestId, ...detail },
    });
    if (deps.telemetry) recordEvent(deps.telemetry, { ...ref, event, detail: {} });
  };

  return {
    /**
     * Confirms the request exists and returns the customer's tickets that an
     * agent may still be working on, so their workflows can be stopped first.
     */
    async beginDeletion(
      ref: DeletionRef,
    ): Promise<{ openTicketIds: string[]; ticketIds: string[] }> {
      const found = await withRowScope(deps.db, scope(ref), async (trx) => {
        const request = await trx
          .selectFrom("deletionRequests")
          .select(["status"])
          .where("id", "=", ref.requestId)
          .executeTakeFirst();
        const all = await trx.selectFrom("tickets").select(["id", "status"]).execute();
        const tickets = all.filter(
          (ticket) =>
            ticket.id !== ref.ticketId &&
            (OPEN_STATUSES as readonly string[]).includes(ticket.status),
        );
        return { request, tickets, all };
      });
      if (!found.request) throw new Error(`No deletion request ${ref.requestId} for this customer`);
      const openTicketIds = found.tickets.map((ticket) => ticket.id);
      if (found.request.status === "requested") {
        await audit(ref, "deletion_started", { openTickets: openTicketIds.length });
      }
      // Every ticket the customer ever had, read now: once the records are
      // erased nothing here will know which conversations were theirs.
      return { openTicketIds, ticketIds: found.all.map((ticket) => ticket.id) };
    },

    /**
     * Returns once none of the customer's agents is running any more. One
     * that is still in the middle of a step makes this fail, and the engine
     * asks again until it has stopped.
     */
    async agentsStopped(input: { workflowIds: string[] }): Promise<void> {
      const giveUpAt = Date.now() + AGENT_WAIT_MS;
      for (;;) {
        const running = await deps.agents.running(input.workflowIds);
        if (running.length === 0) return;
        if (Date.now() >= giveUpAt) {
          throw new Error(`${running.length} agent(s) for this customer are still running`);
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    },

    /** Removes the customer's conversations from the inspection store. */
    async eraseConversations(input: { ref: DeletionRef; ticketIds: string[] }): Promise<number> {
      const { inspection } = deps;
      if (!inspection) return 0;
      // Side by side: each one waits until the store has stayed empty.
      const removed = await Promise.all(
        input.ticketIds.map((ticketId) => inspection.deleteTicket(input.ref.tenantId, ticketId)),
      );
      return removed.filter(Boolean).length;
    },

    /** Closes the billing account and removes the customer's access. */
    async eraseElsewhere(
      ref: DeletionRef,
    ): Promise<Pick<DeletionReport, "billing" | "entitlements">> {
      return {
        billing: await deps.billing.closeAccount(ref),
        entitlements: await deps.entitlements.erase(ref),
      };
    },

    /** Erases the customer from this system's own database, in one transaction. */
    async eraseRecords(ref: DeletionRef): Promise<DeletionReport["records"]> {
      const result = await sql<{ erased: unknown }>`
        select erase_customer(${ref.requestId}, ${deps.clock()}) as erased
      `.execute(deps.db);
      return erasedCounts.parse(result.rows[0]?.erased);
    },

    async eraseIdentity(ref: DeletionRef): Promise<number> {
      return deps.identity.deleteAccount(ref.customerId);
    },

    /** Writes what was done to the audit log: counts, and nothing that was deleted. */
    async finishDeletion(input: { ref: DeletionRef; report: DeletionReport }): Promise<void> {
      await audit(input.ref, "deletion_completed", input.report);
    },
  };
}

export type DeletionActivities = ReturnType<typeof createDeletionActivities>;
