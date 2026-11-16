import { createHash } from "node:crypto";
import {
  type AppDatabase,
  appendAudit,
  type TicketCategory,
  type TicketRoute,
  type TicketRow,
  withRowScope,
} from "@proofdesk/db";
import type { ApprovalDelivery, Dispatch, OutboxJob } from "@proofdesk/dispatch";
import {
  bearerToken,
  CLIENTS,
  type GrantSigner,
  SCOPES,
  type TokenVerifier,
  type VerifiedToken,
} from "@proofdesk/identity";
import { createJsonApp, HttpError, parseBody } from "@proofdesk/service";
import type { Kysely, Transaction } from "kysely";
import { z } from "zod";

export type PortalDeps = {
  /** Connection as `portal_app`: one tenant and one customer per transaction. */
  db: Kysely<AppDatabase>;
  /** Connection as `grants_app`: may read grants and log assertions, nothing else. */
  grantsDb: Kysely<AppDatabase>;
  /** Verifies tokens addressed to the portal. */
  verify: TokenVerifier;
  signer: GrantSigner;
  clock: () => Date;
  newId: (prefix: string) => string;
  /**
   * Hands promised work to the workflow engine: a new ticket, a customer's
   * answer, a deletion request. The work is recorded before this is called,
   * so if it fails, or is absent, nothing is lost and a sweeper starts it.
   */
  dispatch?: Dispatch;
  /**
   * How much one customer may ask of the agent. Budgets cap what a ticket and
   * a company can spend; these stop one account from using up the company's.
   */
  limits?: { ticketsPerHour?: number; openTickets?: number };
  /** The share of tickets the agent resolved itself that staff are asked to check, in percent. */
  reviewSamplePercent?: number;
  /** The real time, for judging how old a sign-in is. Defaults to the system clock. */
  wallClock?: () => Date;
  /** Delivers a staff decision to the ticket's workflow. */
  decideApproval?: ApprovalDelivery;
};

/**
 * What the agent may do for a ticket of each category. The customer chooses
 * the category when submitting, so the ceiling is something the customer
 * authorised, not something the agent inferred from the ticket text.
 */
export const GRANT_SCOPES: Record<TicketCategory, string[]> = {
  refund: [SCOPES.billingRead, SCOPES.billingRefund, SCOPES.documentsRead],
  plan_change: [
    SCOPES.billingRead,
    SCOPES.billingPlan,
    SCOPES.entitlementsRead,
    SCOPES.entitlementsWrite,
    SCOPES.documentsRead,
  ],
  // A deletion is not handled by the agent. These scopes let the deletion
  // workflow act in the other systems, and no model is ever given them.
  data_deletion: [SCOPES.billingErase, SCOPES.entitlementsErase],
};

const GRANT_LIFETIME_DAYS = 30;
const CLOSED: ReadonlySet<string> = new Set(["resolved", "refused"]);
/** Clients a person signs in through. Only these may submit tickets. */
const SIGN_IN_CLIENTS: ReadonlySet<string> = new Set([CLIENTS.portalWeb, CLIENTS.devLogin]);

const submitTicket = z.strictObject({
  // A deletion is requested through its own endpoint, which checks more.
  category: z.enum(["refund", "plan_change"]),
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(10_000),
});

const requestDeletion = z.strictObject({
  /** The customer types their own email address to confirm. */
  confirmEmail: z.string().trim().min(3).max(320),
});

/** A deletion request must come from a sign-in this recent, not from a session left open. */
const MAX_SIGN_IN_AGE_SECONDS = 300;
const DELETION_GRANT_DAYS = 1;

const requestAssertion = z.strictObject({ scope: z.string().min(1).max(100) });

const decideApproval = z.strictObject({ decision: z.enum(["approved", "rejected"]) });

const reviewTicket = z.strictObject({
  verdict: z.enum(["agent_right", "agent_wrong"]),
  expectedOutcome: z.enum([
    "refunded",
    "plan_changed",
    "refused",
    "needs_clarification",
    "handed_to_staff",
  ]),
  /** A reason code, such as `duplicate_charge`. */
  expectedReason: z.string().regex(/^[a-z][a-z_]{1,60}$/),
  /** The refunds that should have been made, by payment id. */
  expectedRefunds: z
    .array(
      z.strictObject({
        paymentId: z.string().regex(/^[A-Za-z0-9_]{3,80}$/),
        amountCents: z.number().int().positive(),
      }),
    )
    .max(10)
    .default([]),
});

const postMessage = z.strictObject({ body: z.string().trim().min(1).max(10_000) });

const staffReply = z.strictObject({
  body: z.string().trim().min(1).max(4000),
  /** How the ticket ends: the request was met, or it was declined. */
  resolution: z.enum(["resolved", "refused"]),
});

type ThreadRow = { ticketId: string; author: string; body: string; createdAt: Date };
/** One ticket's messages after the first, oldest first. */
const thread = (messages: ThreadRow[], ticketId: string) =>
  messages
    .filter((message) => message.ticketId === ticketId)
    .map((message) => ({
      author: message.author,
      body: message.body,
      createdAt: message.createdAt.toISOString(),
    }));

const setControl = z.strictObject({
  /** Leave out to pause or resume the whole agent. */
  tool: z
    .string()
    .regex(/^[a-z][a-z_]{1,60}$/)
    .optional(),
  paused: z.boolean(),
  reason: z.string().trim().min(1).max(200),
});

/**
 * Which build gets a ticket. The ticket's id decides, so the answer is the
 * same however often it is asked, and a share of N sends N in a hundred
 * tickets to the canary.
 */
export function routeFor(ticketId: string, canarySharePercent: number): TicketRoute {
  const bucket = createHash("sha256").update(ticketId).digest().readUInt32BE(0) % 100;
  return bucket < canarySharePercent ? "canary" : "stable";
}

const seenInvoices = z.object({
  invoices: z.array(
    z.object({
      number: z.string(),
      amountCents: z.number(),
      payments: z.array(
        z.object({
          id: z.string(),
          amountCents: z.number(),
          status: z.string(),
          createdAt: z.string(),
          refundedCents: z.number(),
        }),
      ),
    }),
  ),
});
const runWithCalls = z.object({
  toolCalls: z.array(
    z.object({
      tool: z.string(),
      outcome: z.object({ content: z.string(), isError: z.boolean() }),
    }),
  ),
});

/** The invoices the agent read during a run, or none if it read none. */
function invoicesSeen(state: unknown): z.infer<typeof seenInvoices>["invoices"] {
  const run = runWithCalls.safeParse(state);
  if (!run.success) return [];
  const listed = run.data.toolCalls.find(
    (call) => call.tool === "list_invoices" && !call.outcome.isError,
  );
  if (!listed) return [];
  try {
    const parsed = seenInvoices.safeParse(JSON.parse(listed.outcome.content));
    return parsed.success ? parsed.data.invoices : [];
  } catch {
    return [];
  }
}

/**
 * Whether a ticket the agent resolved by itself is put in front of a person.
 * Tickets handed to staff are always reviewed. These are the others: the
 * ones where the agent was confident, which nobody would otherwise look at.
 * The ticket's id decides, so the sample cannot be steered.
 */
export function sampledForReview(ticketId: string, percent: number): boolean {
  const bucket = createHash("sha256").update(`review:${ticketId}`).digest().readUInt32BE(0) % 100;
  return bucket < percent;
}

/** Outcomes the agent reaches without a person. */
const AGENT_RESOLVED: ReadonlySet<string> = new Set(["refunded", "plan_changed", "refused"]);

const toTicket = (row: TicketRow) => ({
  id: row.id,
  category: row.category,
  subject: row.subject,
  body: row.body,
  status: row.status,
  createdAt: row.createdAt.toISOString(),
  reply: row.reply,
});

export function createPortalApp(deps: PortalDeps) {
  const app = createJsonApp();

  async function authenticate(request: Request): Promise<VerifiedToken> {
    const token = bearerToken(request);
    const verified = token ? await deps.verify(token) : null;
    if (!verified) throw new HttpError(401, "unauthenticated", "Authentication is required");
    return verified;
  }

  /** A signed-in customer: a person, through a sign-in client, with a tenant and a customer id. */
  async function customer(request: Request) {
    const token = await authenticate(request);
    if (
      !SIGN_IN_CLIENTS.has(token.client) ||
      !token.scopes.includes(SCOPES.tickets) ||
      !token.tenantId ||
      !token.customerId
    ) {
      throw new HttpError(403, "forbidden", "This action requires a signed-in customer");
    }
    return { tenantId: token.tenantId, customerId: token.customerId, token };
  }

  /** A signed-in member of staff who may decide approvals, limited to their own tenant. */
  async function approver(request: Request) {
    const token = await authenticate(request);
    if (
      !SIGN_IN_CLIENTS.has(token.client) ||
      !token.scopes.includes(SCOPES.approvals) ||
      token.staffRole !== "approver" ||
      !token.tenantId
    ) {
      throw new HttpError(403, "forbidden", "This action requires an approver");
    }
    return { tenantId: token.tenantId, subject: `staff:${token.subject}` };
  }

  /** A signed-in member of staff who may stop and restart the agent in their own tenant. */
  async function operator(request: Request) {
    const token = await authenticate(request);
    if (
      !SIGN_IN_CLIENTS.has(token.client) ||
      !token.scopes.includes(SCOPES.approvals) ||
      token.staffRole !== "operator" ||
      !token.tenantId
    ) {
      throw new HttpError(403, "forbidden", "This action requires an operator");
    }
    return { tenantId: token.tenantId, subject: `staff:${token.subject}` };
  }

  /**
   * Records work for the workflow engine in the caller's transaction. If the
   * transaction commits, the work will happen, whatever becomes of this
   * process afterwards.
   */
  async function promise(trx: Transaction<AppDatabase>, job: OutboxJob) {
    const id = deps.newId("job");
    await trx
      .insertInto("workflowOutbox")
      .values({
        id,
        kind: job.kind,
        tenantId: job.ref.tenantId,
        customerId: job.ref.customerId,
        ticketId: job.ref.ticketId,
        payload: JSON.stringify(job),
        createdAt: deps.clock(),
        startedAt: null,
      })
      .execute();
    return { id, job };
  }

  /**
   * Tries to start promised work right away. A failure here is not the
   * caller's problem: the work is on record, and the sweeper will start it.
   */
  async function handOver(promised: { id: string; job: OutboxJob }): Promise<void> {
    if (!deps.dispatch) return;
    try {
      if ((await deps.dispatch(promised.job)) !== "started") return;
      const { ref } = promised.job;
      await withRowScope(deps.db, { tenantId: ref.tenantId, customerId: ref.customerId }, (trx) =>
        trx
          .updateTable("workflowOutbox")
          .set({ startedAt: deps.clock() })
          .where("id", "=", promised.id)
          .execute(),
      );
    } catch (error) {
      console.warn("Could not start a workflow now; the sweeper will.", error);
    }
  }

  /** A ticket staff are asked to judge: handed over, or sampled from what the agent resolved. */
  const inReview = (ticket: { id: string; outcome: string | null }) =>
    ticket.outcome === "handed_to_staff" ||
    (ticket.outcome !== null &&
      AGENT_RESOLVED.has(ticket.outcome) &&
      sampledForReview(ticket.id, deps.reviewSamplePercent ?? 10));

  app.get("/.well-known/jwks.json", (c) => c.json(deps.signer.jwks()));

  // Tickets the agent gave up on, waiting for a person to say what should
  // have happened. Staff see their own company's tickets and no others.
  app.get("/staff/review-queue", async (c) => {
    const staff = await approver(c.req.raw);
    const rows = await withRowScope(deps.db, { tenantId: staff.tenantId }, (trx) =>
      trx
        .selectFrom("tickets as t")
        .leftJoin("ticketReviews as r", "r.ticketId", "t.id")
        .leftJoin("agentRuns as a", "a.ticketId", "t.id")
        .select([
          "t.id",
          "t.category",
          "t.subject",
          "t.body",
          "t.outcome",
          "t.reasonCode",
          "t.reply",
          "t.resolvedAt",
          "a.state",
        ])
        .where("t.outcome", "is not", null)
        .where("t.category", "<>", "data_deletion")
        .where("r.ticketId", "is", null)
        .orderBy("t.resolvedAt")
        .execute(),
    );
    return c.json({
      tickets: rows.filter(inReview).map((row) => ({
        id: row.id,
        category: row.category,
        subject: row.subject,
        body: row.body,
        // Handed over by the agent, or picked as a check on what it resolved.
        why: row.outcome === "handed_to_staff" ? "handed_over" : "sample",
        outcome: row.outcome,
        reasonCode: row.reasonCode,
        reply: row.reply,
        resolvedAt: row.resolvedAt?.toISOString() ?? null,
        // What the agent read, so the reviewer can name the payment that
        // should have been refunded.
        invoices: invoicesSeen(row.state),
      })),
    });
  });

  // The verdict is fixed words, identifiers and amounts. It is the input to
  // a new eval case, so it must be exact, and it holds no free text.
  app.post("/staff/review-queue/:ticketId", async (c) => {
    const staff = await approver(c.req.raw);
    const input = await parseBody(c.req.raw, reviewTicket);
    const ticketId = c.req.param("ticketId");
    const now = deps.clock();

    await withRowScope(deps.db, { tenantId: staff.tenantId }, async (trx) => {
      const ticket = await trx
        .selectFrom("tickets")
        .select(["id", "outcome"])
        .where("id", "=", ticketId)
        .executeTakeFirst();
      if (!ticket) throw new HttpError(404, "ticket_not_found", "Ticket not found");
      if (!inReview(ticket)) {
        throw new HttpError(409, "not_in_review", "This ticket is not up for review");
      }
      const existing = await trx
        .selectFrom("ticketReviews")
        .select("ticketId")
        .where("ticketId", "=", ticketId)
        .executeTakeFirst();
      if (existing) throw new HttpError(409, "already_reviewed", "This ticket has a verdict");
      await trx
        .insertInto("ticketReviews")
        .values({
          ticketId,
          tenantId: staff.tenantId,
          verdict: input.verdict,
          expectedOutcome: input.expectedOutcome,
          expectedReason: input.expectedReason,
          expectedRefunds: JSON.stringify(input.expectedRefunds),
          reviewedBy: staff.subject,
          reviewedAt: now,
        })
        .execute();
    });
    await appendAudit(deps.db, {
      tenantId: staff.tenantId,
      ticketId,
      at: now,
      actor: staff.subject,
      event: "ticket_reviewed",
      detail: {
        verdict: input.verdict,
        expectedOutcome: input.expectedOutcome,
        expectedReason: input.expectedReason,
      },
    });
    return c.json({ reviewed: true }, 201);
  });

  // Tickets the agent passed to staff and nobody has answered yet.
  app.get("/staff/handed-over", async (c) => {
    const staff = await approver(c.req.raw);
    const { rows, messages } = await withRowScope(
      deps.db,
      { tenantId: staff.tenantId },
      async (trx) => ({
        rows: await trx
          .selectFrom("tickets")
          .select(["id", "category", "subject", "body", "reasonCode", "resolvedAt"])
          .where("status", "=", "handed_to_staff")
          .where("category", "<>", "data_deletion")
          .orderBy("resolvedAt")
          .execute(),
        messages: await trx
          .selectFrom("ticketMessages")
          .select(["ticketId", "author", "body", "createdAt"])
          .orderBy("seq")
          .execute(),
      }),
    );
    return c.json({
      tickets: rows.map((row) => ({
        id: row.id,
        category: row.category,
        subject: row.subject,
        body: row.body,
        reasonCode: row.reasonCode,
        handedOverAt: row.resolvedAt?.toISOString() ?? null,
        messages: thread(messages, row.id),
      })),
    });
  });

  // A member of staff answers the customer and closes the ticket. What the
  // agent did stays on record as it was: the outcome is not rewritten.
  app.post("/staff/tickets/:ticketId/reply", async (c) => {
    const staff = await approver(c.req.raw);
    const input = await parseBody(c.req.raw, staffReply);
    const ticketId = c.req.param("ticketId");
    const now = deps.clock();

    await withRowScope(deps.db, { tenantId: staff.tenantId }, async (trx) => {
      const closed = await trx
        .updateTable("tickets")
        .set({ status: input.resolution, reply: input.body })
        .where("id", "=", ticketId)
        .where("status", "=", "handed_to_staff")
        .returning(["id", "customerId"])
        .executeTakeFirst();
      if (!closed) {
        const exists = await trx
          .selectFrom("tickets")
          .select("id")
          .where("id", "=", ticketId)
          .executeTakeFirst();
        if (!exists) throw new HttpError(404, "ticket_not_found", "Ticket not found");
        throw new HttpError(409, "not_with_staff", "This ticket is not waiting for staff");
      }
      await trx
        .insertInto("ticketMessages")
        .values({
          id: deps.newId("msg"),
          ticketId,
          tenantId: staff.tenantId,
          customerId: closed.customerId,
          author: "staff",
          body: input.body,
          createdAt: now,
        })
        .execute();
    });
    await appendAudit(deps.db, {
      tenantId: staff.tenantId,
      ticketId,
      at: now,
      actor: staff.subject,
      event: "staff_replied",
      // That a person answered, and how it ended. Never what they wrote.
      detail: { resolution: input.resolution },
    });
    return c.json({ replied: true }, 201);
  });

  app.get("/staff/agent-controls", async (c) => {
    const staff = await operator(c.req.raw);
    const rows = await withRowScope(deps.db, { tenantId: staff.tenantId }, (trx) =>
      trx.selectFrom("agentControls").selectAll().orderBy("scope").execute(),
    );
    return c.json({
      controls: rows.map((row) => ({
        scope: row.scope,
        paused: row.paused,
        reason: row.reason,
        setBy: row.setBy,
        setAt: row.setAt.toISOString(),
      })),
    });
  });

  // The kill switch. It takes effect at the agent's next model turn or tool
  // call, including on tickets already in progress and on approved refunds
  // that have not been paid yet.
  app.post("/staff/agent-controls", async (c) => {
    const staff = await operator(c.req.raw);
    const input = await parseBody(c.req.raw, setControl);
    const scope = input.tool ? `tool:${input.tool}` : "agent";
    const now = deps.clock();
    await withRowScope(deps.db, { tenantId: staff.tenantId }, (trx) =>
      trx
        .insertInto("agentControls")
        .values({
          tenantId: staff.tenantId,
          scope,
          paused: input.paused,
          reason: input.reason,
          setBy: staff.subject,
          setAt: now,
        })
        .onConflict((conflict) =>
          conflict.columns(["tenantId", "scope"]).doUpdateSet({
            paused: input.paused,
            reason: input.reason,
            setBy: staff.subject,
            setAt: now,
          }),
        )
        .execute(),
    );
    await appendAudit(deps.db, {
      tenantId: staff.tenantId,
      at: now,
      actor: staff.subject,
      event: input.paused ? "agent_paused" : "agent_resumed",
      detail: { scope, reason: input.reason },
    });
    return c.json({ control: { scope, paused: input.paused } });
  });

  // What is waiting for a decision, with the request it belongs to: nobody
  // should approve a payment without seeing what the customer asked for.
  app.get("/staff/approvals", async (c) => {
    const staff = await approver(c.req.raw);
    const rows = await withRowScope(deps.db, { tenantId: staff.tenantId }, (trx) =>
      trx
        .selectFrom("approvals as a")
        .innerJoin("tickets as t", "t.id", "a.ticketId")
        .select([
          "a.id",
          "a.ticketId",
          "a.tool",
          "a.summary",
          "a.reason",
          "a.requestedAt",
          "t.category",
          "t.subject",
          "t.body",
        ])
        .where("a.status", "=", "pending")
        .orderBy("a.requestedAt")
        .execute(),
    );
    return c.json({
      approvals: rows.map((row) => ({
        id: row.id,
        ticketId: row.ticketId,
        tool: row.tool,
        summary: row.summary,
        reason: row.reason,
        requestedAt: row.requestedAt.toISOString(),
        ticket: { category: row.category, subject: row.subject, body: row.body },
      })),
    });
  });

  app.post("/staff/approvals/:approvalId/decision", async (c) => {
    const staff = await approver(c.req.raw);
    const { decision } = await parseBody(c.req.raw, decideApproval);
    // Row-level security hides other tenants' approvals, so staff of one
    // company cannot decide, or even find, another company's.
    const approval = await withRowScope(deps.db, { tenantId: staff.tenantId }, (trx) =>
      trx
        .selectFrom("approvals")
        .select(["id", "ticketId", "status"])
        .where("id", "=", c.req.param("approvalId"))
        .executeTakeFirst(),
    );
    if (!approval) throw new HttpError(404, "approval_not_found", "Approval not found");
    if (approval.status !== "pending") {
      throw new HttpError(409, "already_decided", `This approval is already ${approval.status}`);
    }
    if (!deps.decideApproval) throw new Error("No approval delivery is configured");
    const delivery = await deps.decideApproval({
      ticketId: approval.ticketId,
      approvalId: approval.id,
      decision,
      decidedBy: staff.subject,
    });
    // The ticket ended while the request waited. Nothing was decided, and
    // saying "accepted" would tell staff that something was. The request is
    // closed here, so it leaves the queue instead of being offered again.
    if (delivery === "closed") {
      const now = deps.clock();
      const expired = await withRowScope(deps.db, { tenantId: staff.tenantId }, (trx) =>
        trx
          .updateTable("approvals")
          .set({ status: "expired", decidedAt: now, decidedBy: "system:ticket-ended" })
          .where("id", "=", approval.id)
          .where("status", "=", "pending")
          .returning("id")
          .executeTakeFirst(),
      );
      if (expired) {
        await appendAudit(deps.db, {
          tenantId: staff.tenantId,
          at: now,
          actor: staff.subject,
          event: "approval_expired",
          detail: { approvalId: approval.id, ticketId: approval.ticketId },
        });
      }
      throw new HttpError(
        409,
        "no_longer_waiting",
        "This ticket is no longer waiting for a decision",
      );
    }
    return c.json({ accepted: true }, 202);
  });

  // A customer asks for their data to be deleted. Nothing here is free text
  // for a model to interpret: the request is a fixed action, confirmed by a
  // fresh sign-in and by the customer typing their own email address.
  app.post("/account/deletion-request", async (c) => {
    const { token, ...scope } = await customer(c.req.raw);
    // When the person actually signed in. A refreshed token has a new issue
    // time and the same sign-in time, so the issue time is used only where
    // the sign-in time is absent.
    const { auth_time: authTime, iat } = token.claims;
    const signedInAt = typeof authTime === "number" ? authTime : typeof iat === "number" ? iat : 0;
    const wallNow = (deps.wallClock ?? (() => new Date()))().getTime() / 1000;
    if (wallNow - signedInAt > MAX_SIGN_IN_AGE_SECONDS) {
      throw new HttpError(401, "sign_in_too_old", "Sign in again to confirm this request");
    }
    const { confirmEmail } = await parseBody(c.req.raw, requestDeletion);
    const now = deps.clock();

    const outcome = await withRowScope(deps.db, scope, async (trx) => {
      const me = await trx
        .selectFrom("customers")
        .select("email")
        .where("id", "=", scope.customerId)
        .executeTakeFirst();
      if (!me || me.email.toLowerCase() !== confirmEmail.toLowerCase()) {
        throw new HttpError(
          422,
          "confirmation_mismatch",
          "The email address does not match this account",
        );
      }
      const open = await trx
        .selectFrom("deletionRequests")
        .select(["id", "ticketId"])
        .where("status", "=", "requested")
        .executeTakeFirst();
      // A repeat creates nothing. If the first request's workflow has not
      // started, the sweeper is already responsible for it.
      if (open) return { requestId: open.id, promised: undefined };

      // From this moment no agent may act for the customer on any ticket.
      await trx
        .updateTable("ticketGrants")
        .set({ revokedAt: now })
        .where("revokedAt", "is", null)
        .execute();

      const ticketId = deps.newId("tkt");
      const requestId = deps.newId("del");
      await trx
        .insertInto("tickets")
        .values({
          id: ticketId,
          ...scope,
          category: "data_deletion",
          subject: "Data deletion request",
          body: "Requested by the customer from their account.",
          status: "open",
          createdAt: now,
          outcome: null,
          reasonCode: null,
          reply: null,
          resolvedAt: null,
        })
        .execute();
      await trx
        .insertInto("ticketGrants")
        .values({
          ticketId,
          ...scope,
          scopes: GRANT_SCOPES.data_deletion,
          createdAt: now,
          expiresAt: new Date(now.getTime() + DELETION_GRANT_DAYS * 86_400_000),
          revokedAt: null,
        })
        .execute();
      await trx
        .insertInto("deletionRequests")
        .values({
          id: requestId,
          ...scope,
          ticketId,
          status: "requested",
          requestedAt: now,
          completedAt: null,
          erased: null,
        })
        .execute();
      return {
        requestId,
        promised: await promise(trx, {
          kind: "deletion",
          ref: { requestId, ticketId, ...scope },
        }),
      };
    });

    if (outcome.promised) await handOver(outcome.promised);
    return c.json({ request: { id: outcome.requestId, status: "requested" } }, 202);
  });

  // Submitting a ticket is also what grants the agent authority to act on it.
  app.post("/tickets", async (c) => {
    const { token: _token, ...scope } = await customer(c.req.raw);
    const input = await parseBody(c.req.raw, submitTicket);
    const now = deps.clock();

    const ticket: TicketRow = {
      id: deps.newId("tkt"),
      ...scope,
      category: input.category,
      subject: input.subject,
      body: input.body,
      status: "open",
      createdAt: now,
      outcome: null,
      reasonCode: null,
      reply: null,
      resolvedAt: null,
    };
    const job = await withRowScope(deps.db, scope, async (trx) => {
      // One customer cannot flood the agent. Both counts are of their own
      // tickets only, which is all this transaction can see.
      const mine = await trx
        .selectFrom("tickets")
        .select(["status", "createdAt"])
        .where("category", "<>", "data_deletion")
        .execute();
      const lastHour = mine.filter(
        (row) => row.createdAt.getTime() > now.getTime() - 3_600_000,
      ).length;
      const open = mine.filter((row) => row.status === "open").length;
      if (
        lastHour >= (deps.limits?.ticketsPerHour ?? 20) ||
        open >= (deps.limits?.openTickets ?? 5)
      ) {
        throw new HttpError(
          429,
          "too_many_requests",
          "You have several requests in progress. Please wait for a reply before sending more.",
        );
      }
      const rollout = await trx
        .selectFrom("rollout")
        .select("canaryShare")
        .where("id", "=", "agent")
        .executeTakeFirst();
      const chosen = routeFor(ticket.id, rollout?.canaryShare ?? 0);
      await trx
        .insertInto("tickets")
        .values({ ...ticket, route: chosen })
        .execute();
      await trx
        .insertInto("ticketGrants")
        .values({
          ticketId: ticket.id,
          ...scope,
          scopes: GRANT_SCOPES[input.category],
          createdAt: now,
          expiresAt: new Date(now.getTime() + GRANT_LIFETIME_DAYS * 86_400_000),
          revokedAt: null,
        })
        .execute();
      return promise(trx, {
        kind: "ticket",
        ref: { ticketId: ticket.id, ...scope },
        route: chosen,
      });
    });
    await handOver(job);
    return c.json({ ticket: toTicket(ticket) }, 201);
  });

  app.get("/tickets", async (c) => {
    const { token: _token, ...scope } = await customer(c.req.raw);
    const { rows, messages } = await withRowScope(deps.db, scope, async (trx) => ({
      rows: await trx
        .selectFrom("tickets")
        .selectAll()
        .where("category", "<>", "data_deletion")
        .orderBy("createdAt", "desc")
        .orderBy("id")
        .execute(),
      messages: await trx
        .selectFrom("ticketMessages")
        .select(["ticketId", "author", "body", "createdAt"])
        .orderBy("seq")
        .execute(),
    }));
    return c.json({
      tickets: rows.map((row) => ({ ...toTicket(row), messages: thread(messages, row.id) })),
    });
  });

  // The customer answers a question the agent asked. The agent then carries
  // on with the same ticket, with everything said so far.
  app.post("/tickets/:ticketId/messages", async (c) => {
    const { token: _token, ...scope } = await customer(c.req.raw);
    const { body } = await parseBody(c.req.raw, postMessage);
    const ticketId = c.req.param("ticketId");
    const now = deps.clock();

    const promised = await withRowScope(deps.db, scope, async (trx) => {
      // Only a ticket that is waiting for the customer takes a reply. The
      // update is what claims it: of two replies sent at once, one wins.
      const reopened = await trx
        .updateTable("tickets")
        .set({ status: "open" })
        .where("id", "=", ticketId)
        .where("status", "=", "waiting_customer")
        .returning(["id", "route"])
        .executeTakeFirst();
      if (!reopened) {
        const exists = await trx
          .selectFrom("tickets")
          .select("id")
          .where("id", "=", ticketId)
          .executeTakeFirst();
        if (!exists) throw new HttpError(404, "ticket_not_found", "Ticket not found");
        throw new HttpError(409, "not_waiting_for_you", "This ticket is not waiting for a reply");
      }
      const messageId = deps.newId("msg");
      await trx
        .insertInto("ticketMessages")
        .values({ id: messageId, ticketId, ...scope, author: "customer", body, createdAt: now })
        .execute();
      return promise(trx, {
        kind: "follow_up",
        ref: { ticketId, ...scope },
        route: reopened.route,
        messageId,
      });
    });
    await handOver(promised);
    return c.json({ accepted: true }, 202);
  });

  // A customer can withdraw the agent's authority at any time.
  app.post("/tickets/:ticketId/revoke-grant", async (c) => {
    const { token: _token, ...scope } = await customer(c.req.raw);
    const revoked = await withRowScope(deps.db, scope, (trx) =>
      trx
        .updateTable("ticketGrants")
        .set({ revokedAt: deps.clock() })
        .where("ticketId", "=", c.req.param("ticketId"))
        .where("revokedAt", "is", null)
        .returning("ticketId")
        .executeTakeFirst(),
    );
    if (!revoked) throw new HttpError(404, "grant_not_found", "No active grant for this ticket");
    return c.json({ revoked: true });
  });

  // The agent's worker asks for authority to make one tool call. The answer
  // is a signed, single-use assertion that Keycloak trades for a short token.
  app.post("/internal/tickets/:ticketId/assertion", async (c) => {
    const token = await authenticate(c.req.raw);
    if (token.client !== CLIENTS.worker || !token.scopes.includes(SCOPES.grantsIssue)) {
      throw new HttpError(403, "forbidden", "Only the agent worker may request assertions");
    }
    const { scope } = await parseBody(c.req.raw, requestAssertion);
    const ticketId = c.req.param("ticketId");

    const grant = await deps.grantsDb
      .selectFrom("ticketGrants as g")
      .innerJoin("tickets as t", "t.id", "g.ticketId")
      .select(["g.tenantId", "g.customerId", "g.scopes", "g.expiresAt", "g.revokedAt", "t.status"])
      .where("g.ticketId", "=", ticketId)
      .executeTakeFirst();

    const refuse = (code: string, message: string) => new HttpError(403, code, message);
    if (!grant) throw new HttpError(404, "grant_not_found", "No grant exists for this ticket");
    if (grant.revokedAt) throw refuse("grant_revoked", "The customer withdrew this grant");
    if (grant.expiresAt <= deps.clock()) throw refuse("grant_expired", "This grant has expired");
    if (CLOSED.has(grant.status)) throw refuse("ticket_closed", "This ticket is closed");
    if (!grant.scopes.includes(scope)) {
      throw refuse("scope_not_granted", `This ticket's grant does not include "${scope}"`);
    }

    const { assertion, jti } = await deps.signer.sign({
      customerId: grant.customerId,
      scopes: [scope],
    });
    await deps.grantsDb
      .insertInto("grantAssertions")
      .values({
        jti,
        ticketId,
        tenantId: grant.tenantId,
        scope,
        issuedTo: `${token.client}:${token.subject}`,
        issuedAt: deps.clock(),
      })
      .execute();
    return c.json({ assertion });
  });

  return app;
}
