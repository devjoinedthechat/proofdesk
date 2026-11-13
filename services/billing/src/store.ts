import { createHash } from "node:crypto";
import { type RowScope, withRowScope } from "@proofdesk/db";
import { HttpError, type Principal } from "@proofdesk/service";
import { type Kysely, sql, type Transaction } from "kysely";
import type {
  AccountClosed,
  ChangeSubscriptionRequest,
  CreateRefundRequest,
  Invoice,
  PlanChange,
  Refund,
  Subscription,
} from "./api.ts";
import { accountClosed } from "./api.ts";
import type { BillingDatabase, PlanChangeRow, RefundRow } from "./schema.ts";

export type BillingDeps = {
  /** A connection as the `billing_app` role, which is subject to row-level security. */
  db: Kysely<BillingDatabase>;
  clock: () => Date;
  newId: (prefix: string) => string;
};

const UNIQUE_VIOLATION = "23505";

type Reader = Kysely<BillingDatabase> | Transaction<BillingDatabase>;

/** The rows a principal may see. The database enforces this, not the queries. */
export function rowScopeOf(principal: Principal): RowScope {
  return principal.customerId === undefined
    ? { tenantId: principal.tenantId }
    : { tenantId: principal.tenantId, customerId: principal.customerId };
}

function toRefund(row: RefundRow): Refund {
  return {
    id: row.id,
    paymentId: row.paymentId,
    amountCents: row.amountCents,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
  };
}

function fingerprint(request: CreateRefundRequest): string {
  const canonical = JSON.stringify([request.paymentId, request.amountCents, request.reason]);
  return createHash("sha256").update(canonical).digest("hex");
}

export async function listSubscriptions(
  db: Reader,
  tenantId: string,
  customerId: string,
): Promise<Subscription[]> {
  const rows = await db
    .selectFrom("subscriptions as s")
    .innerJoin("plans as p", "p.id", "s.planId")
    .select([
      "s.id",
      "s.customerId",
      "s.status",
      "s.seats",
      "s.startedAt",
      "s.currentPeriodStart",
      "s.currentPeriodEnd",
      "s.canceledAt",
      "p.code",
      "p.name",
      "p.billingInterval",
      "p.priceCents",
      "p.currency",
    ])
    .where("s.tenantId", "=", tenantId)
    .where("s.customerId", "=", customerId)
    .orderBy("s.startedAt")
    .orderBy("s.id")
    .execute();

  return rows.map((row) => ({
    id: row.id,
    customerId: row.customerId,
    status: row.status,
    seats: row.seats,
    startedAt: row.startedAt.toISOString(),
    currentPeriodStart: row.currentPeriodStart.toISOString(),
    currentPeriodEnd: row.currentPeriodEnd.toISOString(),
    canceledAt: row.canceledAt?.toISOString() ?? null,
    plan: {
      code: row.code,
      name: row.name,
      billingInterval: row.billingInterval,
      priceCents: row.priceCents,
      currency: row.currency,
    },
  }));
}

/** Invoices for one customer, newest first, each with its payments and their refunds. */
export async function listInvoices(
  db: Reader,
  tenantId: string,
  customerId: string,
  filter: { number?: string } = {},
): Promise<Invoice[]> {
  let query = db
    .selectFrom("invoices")
    .selectAll()
    .where("tenantId", "=", tenantId)
    .where("customerId", "=", customerId);
  if (filter.number !== undefined) query = query.where("number", "=", filter.number);
  const invoices = await query.orderBy("issuedAt", "desc").orderBy("id").execute();
  if (invoices.length === 0) return [];

  const payments = await db
    .selectFrom("payments")
    .selectAll()
    .where(
      "invoiceId",
      "in",
      invoices.map((row) => row.id),
    )
    .orderBy("createdAt")
    .orderBy("id")
    .execute();

  const refunds =
    payments.length === 0
      ? []
      : await db
          .selectFrom("refunds")
          .selectAll()
          .where(
            "paymentId",
            "in",
            payments.map((row) => row.id),
          )
          .orderBy("createdAt")
          .orderBy("id")
          .execute();

  return invoices.map((inv) => ({
    id: inv.id,
    number: inv.number,
    customerId: inv.customerId,
    subscriptionId: inv.subscriptionId,
    status: inv.status,
    amountCents: inv.amountCents,
    currency: inv.currency,
    periodStart: inv.periodStart.toISOString(),
    periodEnd: inv.periodEnd.toISOString(),
    issuedAt: inv.issuedAt.toISOString(),
    reference: inv.reference,
    payments: payments
      .filter((pay) => pay.invoiceId === inv.id)
      .map((pay) => {
        const own = refunds.filter((ref) => ref.paymentId === pay.id);
        return {
          id: pay.id,
          amountCents: pay.amountCents,
          status: pay.status,
          createdAt: pay.createdAt.toISOString(),
          refundedCents: own.reduce((sum, ref) => sum + ref.amountCents, 0),
          refunds: own.map(toRefund),
        };
      }),
  }));
}

async function findByKey(
  db: Reader,
  tenantId: string,
  idempotencyKey: string,
): Promise<RefundRow | undefined> {
  return db
    .selectFrom("refunds")
    .selectAll()
    .where("tenantId", "=", tenantId)
    .where("idempotencyKey", "=", idempotencyKey)
    .executeTakeFirst();
}

function replay(existing: RefundRow, requestFingerprint: string) {
  if (existing.requestFingerprint !== requestFingerprint) {
    throw new HttpError(
      409,
      "idempotency_key_reused",
      "This idempotency key was already used for a different refund",
    );
  }
  return { refund: toRefund(existing), replayed: true };
}

/**
 * Issues a refund exactly once per idempotency key.
 *
 * Billing enforces what must always hold: the payment exists, it settled, and
 * refunds never exceed what was paid. Whether a refund is allowed by company
 * policy is not decided here; that belongs to the caller.
 */
export async function createRefund(
  deps: BillingDeps,
  principal: Principal,
  request: CreateRefundRequest,
  idempotencyKey: string,
): Promise<{ refund: Refund; replayed: boolean }> {
  const requestFingerprint = fingerprint(request);

  const scope = rowScopeOf(principal);

  try {
    return await withRowScope(deps.db, scope, async (trx) => {
      // The row lock serialises refunds against one payment, so the refundable
      // amount below cannot be spent twice by concurrent requests. Row-level
      // security hides payments outside the caller's tenant or customer.
      const payment = await trx
        .selectFrom("payments")
        .selectAll()
        .where("id", "=", request.paymentId)
        .where("tenantId", "=", principal.tenantId)
        .forUpdate()
        .executeTakeFirst();

      const existing = await findByKey(trx, principal.tenantId, idempotencyKey);
      if (existing) return replay(existing, requestFingerprint);

      if (!payment) throw new HttpError(404, "payment_not_found", "Payment not found");

      if (payment.status !== "succeeded") {
        throw new HttpError(
          422,
          "payment_not_refundable",
          `A payment with status "${payment.status}" cannot be refunded`,
        );
      }

      const { refundedCents } = await trx
        .selectFrom("refunds")
        .select((eb) =>
          eb.fn.coalesce(eb.fn.sum<number>("amountCents"), eb.lit(0)).as("refundedCents"),
        )
        .where("paymentId", "=", payment.id)
        .executeTakeFirstOrThrow();

      const refundableCents = payment.amountCents - Number(refundedCents);
      if (request.amountCents > refundableCents) {
        throw new HttpError(
          422,
          "amount_exceeds_refundable",
          `Only ${refundableCents} cents remain refundable on this payment`,
        );
      }

      const row: RefundRow = {
        id: deps.newId("ref"),
        tenantId: principal.tenantId,
        paymentId: payment.id,
        amountCents: request.amountCents,
        reason: request.reason,
        createdBy: principal.subject,
        createdAt: deps.clock(),
        idempotencyKey,
        requestFingerprint,
      };
      await trx.insertInto("refunds").values(row).execute();
      return { refund: toRefund(row), replayed: false };
    });
  } catch (error) {
    // Two requests with one key but different payments are not serialised by
    // the row lock. The unique index catches the loser, which then replays.
    if ((error as { code?: string }).code !== UNIQUE_VIOLATION) throw error;
    const existing = await withRowScope(deps.db, scope, (trx) =>
      findByKey(trx, principal.tenantId, idempotencyKey),
    );
    // The key exists but belongs to a refund this caller cannot see.
    if (!existing) {
      throw new HttpError(
        409,
        "idempotency_key_reused",
        "This idempotency key was already used for a different refund",
      );
    }
    return replay(existing, requestFingerprint);
  }
}

async function toPlanChange(db: Reader, row: PlanChangeRow): Promise<PlanChange> {
  const plans = await db
    .selectFrom("plans")
    .select(["id", "code"])
    .where("id", "in", [row.fromPlanId, row.toPlanId])
    .execute();
  const code = (id: string) => plans.find((plan) => plan.id === id)?.code ?? id;
  return {
    id: row.id,
    subscriptionId: row.subscriptionId,
    from: { planCode: code(row.fromPlanId), seats: row.fromSeats },
    to: { planCode: code(row.toPlanId), seats: row.toSeats },
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Changes a subscription's plan or seats, exactly once per idempotency key.
 * The change takes effect for the next renewal; nothing is charged here.
 *
 * Billing enforces what must hold: the subscription is active, the plan
 * exists for this tenant, and it bills on the same interval. Moving between
 * monthly and annual means settling the current period, which is not a
 * change this service makes.
 */
export async function changeSubscription(
  deps: BillingDeps,
  principal: Principal,
  subscriptionId: string,
  request: ChangeSubscriptionRequest,
  idempotencyKey: string,
): Promise<{ change: PlanChange; replayed: boolean }> {
  const requestFingerprint = createHash("sha256")
    .update(JSON.stringify([subscriptionId, request.planCode, request.seats]))
    .digest("hex");
  const scope = rowScopeOf(principal);
  const byKey = (db: Reader) =>
    db
      .selectFrom("planChanges")
      .selectAll()
      .where("tenantId", "=", principal.tenantId)
      .where("idempotencyKey", "=", idempotencyKey)
      .executeTakeFirst();
  const replay = async (db: Reader, existing: PlanChangeRow) => {
    if (existing.requestFingerprint !== requestFingerprint) {
      throw new HttpError(
        409,
        "idempotency_key_reused",
        "This idempotency key was already used for a different change",
      );
    }
    return { change: await toPlanChange(db, existing), replayed: true };
  };

  try {
    return await withRowScope(deps.db, scope, async (trx) => {
      const subscription = await trx
        .selectFrom("subscriptions")
        .selectAll()
        .where("id", "=", subscriptionId)
        .where("tenantId", "=", principal.tenantId)
        .forUpdate()
        .executeTakeFirst();

      const existing = await byKey(trx);
      if (existing) return replay(trx, existing);
      if (!subscription) {
        throw new HttpError(404, "subscription_not_found", "Subscription not found");
      }
      if (subscription.status !== "active") {
        throw new HttpError(
          422,
          "subscription_not_active",
          `A subscription with status "${subscription.status}" cannot be changed`,
        );
      }

      const plans = await trx.selectFrom("plans").selectAll().execute();
      const current = plans.find((plan) => plan.id === subscription.planId);
      const target = plans.find((plan) => plan.code === request.planCode);
      if (!target || !current) {
        throw new HttpError(422, "plan_not_available", `There is no plan "${request.planCode}"`);
      }
      if (target.billingInterval !== current.billingInterval) {
        throw new HttpError(
          422,
          "interval_change_not_supported",
          "Changing between monthly and annual billing cannot be done here",
        );
      }
      if (target.id === subscription.planId && request.seats === subscription.seats) {
        throw new HttpError(422, "no_change", "The subscription already has this plan and seats");
      }

      const row: PlanChangeRow = {
        id: deps.newId("chg"),
        tenantId: principal.tenantId,
        customerId: subscription.customerId,
        subscriptionId,
        fromPlanId: subscription.planId,
        fromSeats: subscription.seats,
        toPlanId: target.id,
        toSeats: request.seats,
        status: "applied",
        createdBy: principal.subject,
        createdAt: deps.clock(),
        revertedAt: null,
        idempotencyKey,
        requestFingerprint,
      };
      await trx.insertInto("planChanges").values(row).execute();
      await trx
        .updateTable("subscriptions")
        .set({ planId: target.id, seats: request.seats })
        .where("id", "=", subscriptionId)
        .execute();
      return { change: await toPlanChange(trx, row), replayed: false };
    });
  } catch (error) {
    if ((error as { code?: string }).code !== UNIQUE_VIOLATION) throw error;
    const existing = await withRowScope(deps.db, scope, (trx) => byKey(trx));
    if (!existing) throw error;
    return replay(deps.db, existing);
  }
}

/**
 * Undoes a change, putting the subscription back exactly as it was. Undoing
 * twice is harmless. It is refused if the subscription has been changed again
 * since, because then "as it was" is no longer the right state.
 */
export async function revertPlanChange(
  deps: BillingDeps,
  principal: Principal,
  changeId: string,
): Promise<PlanChange> {
  return withRowScope(deps.db, rowScopeOf(principal), async (trx) => {
    const change = await trx
      .selectFrom("planChanges")
      .selectAll()
      .where("id", "=", changeId)
      .where("tenantId", "=", principal.tenantId)
      .forUpdate()
      .executeTakeFirst();
    if (!change) throw new HttpError(404, "change_not_found", "Plan change not found");
    if (change.status === "reverted") return toPlanChange(trx, change);

    const reverted = await trx
      .updateTable("subscriptions")
      .set({ planId: change.fromPlanId, seats: change.fromSeats })
      .where("id", "=", change.subscriptionId)
      .where("planId", "=", change.toPlanId)
      .where("seats", "=", change.toSeats)
      .returning("id")
      .executeTakeFirst();
    if (!reverted) {
      throw new HttpError(
        409,
        "subscription_changed_since",
        "The subscription was changed again after this change and cannot be reverted to it",
      );
    }
    const revertedAt = deps.clock();
    await trx
      .updateTable("planChanges")
      .set({ status: "reverted", revertedAt })
      .where("id", "=", changeId)
      .execute();
    return toPlanChange(trx, { ...change, status: "reverted", revertedAt });
  });
}

/**
 * Closes a customer's account at their request: cancels every subscription
 * that is still running and clears the text they typed onto invoices.
 * Invoices, payments and refunds stay, because the company must keep them.
 * Safe to repeat: a second call finds nothing left to change.
 */
export async function closeAccount(
  deps: BillingDeps,
  principal: Principal,
  customerId: string,
): Promise<AccountClosed> {
  // The service's own role cannot cancel a subscription or edit an invoice.
  // It calls one database function, which acts only inside the row scope.
  return withRowScope(deps.db, rowScopeOf(principal), async (trx) => {
    const result = await sql<{ closed: unknown }>`
      select close_customer_account(${principal.tenantId}, ${customerId}, ${deps.clock()}) as closed
    `.execute(trx);
    return accountClosed.shape.closed.parse(result.rows[0]?.closed);
  });
}
