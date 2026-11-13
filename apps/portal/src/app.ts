import { type AppDatabase, type TicketCategory, type TicketRow, withRowScope } from "@proofdesk/db";
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
};

/**
 * What the agent may do for a ticket of each category. The customer chooses
 * the category when submitting, so the ceiling is something the customer
 * authorised, not something the agent inferred from the ticket text.
 */
export const GRANT_SCOPES: Record<TicketCategory, string[]> = {
  refund: [SCOPES.billingRead, SCOPES.billingRefund],
  plan_change: [SCOPES.billingRead],
  data_deletion: [],
};

const GRANT_LIFETIME_DAYS = 30;
const CLOSED: ReadonlySet<string> = new Set(["resolved", "refused"]);
/** Clients a person signs in through. Only these may submit tickets. */
const SIGN_IN_CLIENTS: ReadonlySet<string> = new Set([CLIENTS.portalWeb, CLIENTS.devLogin]);

const submitTicket = z.strictObject({
  category: z.enum(["refund", "plan_change", "data_deletion"]),
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(10_000),
});

const requestAssertion = z.strictObject({ scope: z.string().min(1).max(100) });

const toTicket = (row: TicketRow) => ({
  id: row.id,
  category: row.category,
  subject: row.subject,
  body: row.body,
  status: row.status,
  createdAt: row.createdAt.toISOString(),
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
    return { tenantId: token.tenantId, customerId: token.customerId };
  }

  app.get("/.well-known/jwks.json", (c) => c.json(deps.signer.jwks()));

  // Submitting a ticket is also what grants the agent authority to act on it.
  app.post("/tickets", async (c) => {
    const scope = await customer(c.req.raw);
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
    };
    await withRowScope(deps.db, scope, async (trx) => {
      await trx.insertInto("tickets").values(ticket).execute();
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
    });
    return c.json({ ticket: toTicket(ticket) }, 201);
  });

  app.get("/tickets", async (c) => {
    const scope = await customer(c.req.raw);
    const rows = await withRowScope(deps.db, scope, (trx) =>
      trx.selectFrom("tickets").selectAll().orderBy("createdAt", "desc").orderBy("id").execute(),
    );
    return c.json({ tickets: rows.map(toTicket) });
  });

  // A customer can withdraw the agent's authority at any time.
  app.post("/tickets/:ticketId/revoke-grant", async (c) => {
    const scope = await customer(c.req.raw);
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
