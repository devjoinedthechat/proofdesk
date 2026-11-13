import { createHash } from "node:crypto";
import { type RowScope, withRowScope } from "@proofdesk/db";
import { HttpError, type Principal } from "@proofdesk/service";
import type { Kysely, Transaction } from "kysely";
import type { CreateRefundRequest, Invoice, Refund, Subscription } from "./api.ts";
import type { BillingDatabase, RefundRow } from "./schema.ts";

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
