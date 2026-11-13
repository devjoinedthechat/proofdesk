import { createHash } from "node:crypto";
import {
  type AppDatabase,
  appendAudit,
  type TicketCategory,
  type TicketRoute,
  type TicketRow,
  withRowScope,
} from "@proofdesk/db";
import {
  bearerToken,
  CLIENTS,
  type GrantSigner,
  SCOPES,
  type TokenVerifier,
  type VerifiedToken,
} from "@proofdesk/identity";
import { createJsonApp, HttpError, parseBody } from "@proofdesk/service";
import type { Kysely } from "kysely";
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
   * Hands a new ticket to the agent. In production this starts the ticket's
   * workflow, on the task queue of the build the ticket was routed to.
   */
  onTicketCreated?: (ref: {
    ticketId: string;
    tenantId: string;
    customerId: string;
    route: TicketRoute;
  }) => Promise<void>;
  /** Hands a deletion request to the workflow that carries it out. */
  onDeletionRequested?: (ref: {
    requestId: string;
    ticketId: string;
    tenantId: string;
    customerId: string;
  }) => Promise<void>;
  /** The real time, for judging how old a sign-in is. Defaults to the system clock. */
  wallClock?: () => Date;
  /** Delivers a staff decision to the ticket's workflow. */
  decideApproval?: (decision: {
    ticketId: string;
    approvalId: string;
    decision: "approved" | "rejected";
    decidedBy: string;
  }) => Promise<void>;
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

  app.get("/.well-known/jwks.json", (c) => c.json(deps.signer.jwks()));

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

  app.get("/staff/approvals", async (c) => {
    const staff = await approver(c.req.raw);
    const rows = await withRowScope(deps.db, { tenantId: staff.tenantId }, (trx) =>
      trx
        .selectFrom("approvals")
        .selectAll()
        .where("status", "=", "pending")
        .orderBy("requestedAt")
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
    await deps.decideApproval({
      ticketId: approval.ticketId,
      approvalId: approval.id,
      decision,
      decidedBy: staff.subject,
    });
    return c.json({ accepted: true }, 202);
  });

  // A customer asks for their data to be deleted. Nothing here is free text
  // for a model to interpret: the request is a fixed action, confirmed by a
  // fresh sign-in and by the customer typing their own email address.
  app.post("/account/deletion-request", async (c) => {
    const { token, ...scope } = await customer(c.req.raw);
    const issuedAt = typeof token.claims.iat === "number" ? token.claims.iat : 0;
    const wallNow = (deps.wallClock ?? (() => new Date()))().getTime() / 1000;
    if (wallNow - issuedAt > MAX_SIGN_IN_AGE_SECONDS) {
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
      if (open) return { requestId: open.id, ticketId: open.ticketId, created: false };

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
      return { requestId, ticketId, created: true };
    });

    // Also on a repeat, so a request whose workflow failed to start is picked up.
    await deps.onDeletionRequested?.({
      requestId: outcome.requestId,
      ticketId: outcome.ticketId,
      ...scope,
    });
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
    const route = await withRowScope(deps.db, scope, async (trx) => {
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
      return chosen;
    });
    await deps.onTicketCreated?.({ ticketId: ticket.id, ...scope, route });
    return c.json({ ticket: toTicket(ticket) }, 201);
  });

  app.get("/tickets", async (c) => {
    const { token: _token, ...scope } = await customer(c.req.raw);
    const rows = await withRowScope(deps.db, scope, (trx) =>
      trx.selectFrom("tickets").selectAll().orderBy("createdAt", "desc").orderBy("id").execute(),
    );
    return c.json({ tickets: rows.map(toTicket) });
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
