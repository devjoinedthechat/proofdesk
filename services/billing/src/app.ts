import { withRowScope } from "@proofdesk/db";
import {
  type Authenticate,
  assertCustomerAccess,
  createServiceApp,
  HttpError,
  parseBody,
  requireScope,
} from "@proofdesk/service";
import { createRefundRequest } from "./api.ts";
import {
  type BillingDeps,
  createRefund,
  listInvoices,
  listSubscriptions,
  rowScopeOf,
} from "./store.ts";

/** The scopes this service understands. */
export const BILLING_SCOPES = { read: "billing:read", refund: "billing:refund" } as const;

const IDEMPOTENCY_KEY = /^[\x21-\x7e]{8,200}$/;

export function createBillingApp(deps: BillingDeps & { authenticate: Authenticate }) {
  const app = createServiceApp(deps.authenticate);

  app.get("/customers/:customerId/subscriptions", async (c) => {
    const principal = c.get("principal");
    const customerId = c.req.param("customerId");
    requireScope(principal, BILLING_SCOPES.read);
    assertCustomerAccess(principal, customerId);
    const subscriptions = await withRowScope(deps.db, rowScopeOf(principal), (trx) =>
      listSubscriptions(trx, principal.tenantId, customerId),
    );
    return c.json({ subscriptions });
  });

  app.get("/customers/:customerId/invoices", async (c) => {
    const principal = c.get("principal");
    const customerId = c.req.param("customerId");
    requireScope(principal, BILLING_SCOPES.read);
    assertCustomerAccess(principal, customerId);
    const number = c.req.query("number");
    const invoices = await withRowScope(deps.db, rowScopeOf(principal), (trx) =>
      listInvoices(trx, principal.tenantId, customerId, number === undefined ? {} : { number }),
    );
    return c.json({ invoices });
  });

  app.post("/refunds", async (c) => {
    const principal = c.get("principal");
    requireScope(principal, BILLING_SCOPES.refund);
    const idempotencyKey = c.req.header("idempotency-key");
    if (idempotencyKey === undefined || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
      throw new HttpError(
        400,
        "idempotency_key_required",
        "Refunds require an Idempotency-Key header of 8 to 200 printable characters",
      );
    }
    const request = await parseBody(c.req.raw, createRefundRequest);
    const { refund, replayed } = await createRefund(deps, principal, request, idempotencyKey);
    return c.json({ refund }, replayed ? 200 : 201);
  });

  return app;
}
