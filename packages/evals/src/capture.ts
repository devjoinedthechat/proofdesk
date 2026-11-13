import { createHash } from "node:crypto";
import type { AppDatabase } from "@proofdesk/db";
import {
  CATALOG,
  type Outcome,
  type ScenarioCase,
  type ScenarioSpec,
  TENANT_SLUGS,
  type TenantSlug,
} from "@proofdesk/simulator";
import type { Kysely } from "kysely";
import { z } from "zod";

// From a ticket the agent got wrong to a test that would have caught it.
//
// A captured case holds what the agent saw (the ticket and the billing
// records it read), and what staff said the result should have been. It is
// rebuilt as an ordinary scenario, so it runs in the same suites and is
// judged the same way: on the final state of the company.
//
// It is made from a real ticket, so it is treated as personal data until a
// person has read it. See `textReviewed`.

const DAY_MS = 86_400_000;
const OUTCOMES = [
  "refunded",
  "plan_changed",
  "refused",
  "needs_clarification",
  "handed_to_staff",
] as const;

export const capturedCase = z.strictObject({
  version: z.literal(1),
  /** Derived from the ticket id by a one-way hash. The ticket id itself is not kept. */
  id: z.string().regex(/^case_[0-9a-f]{12}$/),
  tenant: z.enum(TENANT_SLUGS as [TenantSlug, ...TenantSlug[]]),
  /**
   * False until a person has read the subject and body and removed anything
   * that identifies someone. The capture replaces the customer's name and
   * email address, and it cannot know what else a customer wrote about
   * themselves. A case that is not reviewed is never loaded.
   */
  textReviewed: z.boolean(),
  ticket: z.strictObject({
    category: z.enum(["refund", "plan_change"]),
    /** Invoice numbers appear as `{{invoice:N}}` and are filled in when the case is rebuilt. */
    subject: z.string(),
    body: z.string(),
  }),
  /** The billing records the agent read, with every date as an age relative to the ticket. */
  invoices: z.array(
    z.strictObject({
      issuedDaysAgo: z.number().nonnegative(),
      amountCents: z.number().int().nonnegative(),
      status: z.enum(["open", "paid", "void"]),
      payments: z.array(
        z.strictObject({
          daysAgo: z.number().nonnegative(),
          status: z.enum(["succeeded", "failed", "disputed"]),
          refunds: z.array(
            z.strictObject({
              daysAgo: z.number().nonnegative(),
              reason: z.enum(["duplicate_charge", "customer_request", "service_credit"]),
              amountCents: z.number().int().positive(),
            }),
          ),
        }),
      ),
    }),
  ),
  /** What the agent did. */
  observed: z.strictObject({ outcome: z.string(), reasonCode: z.string() }),
  /** What staff said it should have done. */
  expected: z.strictObject({
    outcome: z.enum(OUTCOMES),
    reasonCode: z.string(),
    /** Each refund names its payment by position in `invoices`. */
    refunds: z.array(
      z.strictObject({
        invoice: z.number().int().nonnegative(),
        payment: z.number().int().nonnegative(),
        amountCents: z.number().int().positive(),
      }),
    ),
  }),
});

export type CapturedCase = z.infer<typeof capturedCase>;

const billingRecords = z.object({
  invoices: z.array(
    z.object({
      number: z.string(),
      status: z.enum(["open", "paid", "void"]),
      amountCents: z.number().int().nonnegative(),
      issuedAt: z.iso.datetime(),
      payments: z.array(
        z.object({
          id: z.string(),
          status: z.enum(["succeeded", "failed", "disputed"]),
          createdAt: z.iso.datetime(),
          refunds: z.array(
            z.object({
              reason: z.enum(["duplicate_charge", "customer_request", "service_credit"]),
              amountCents: z.number().int().positive(),
              createdAt: z.iso.datetime(),
            }),
          ),
        }),
      ),
    }),
  ),
});
const runState = z.object({
  toolCalls: z.array(
    z.object({
      tool: z.string(),
      outcome: z.object({ content: z.string(), isError: z.boolean() }),
    }),
  ),
});
const expectedRefunds = z.array(z.object({ paymentId: z.string(), amountCents: z.number().int() }));

const escapeForPattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Replaces what is known to identify the customer. A person still has to read the result. */
export function scrub(text: string, customer: { name: string; email: string }): string {
  let result = text.replaceAll(new RegExp(escapeForPattern(customer.email), "gi"), "[email]");
  // Any other email address is someone's, too.
  result = result.replaceAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]");
  const parts = [customer.name, ...customer.name.split(/\s+/).filter((part) => part.length >= 3)];
  for (const part of parts) {
    result = result.replaceAll(new RegExp(`\\b${escapeForPattern(part)}\\b`, "gi"), "[name]");
  }
  return result;
}

/**
 * Builds a case from a reviewed ticket. `db` is a connection that can read
 * the ticket, its run and its review: this is an operator's tool, run with
 * the operator's access, not something the agent or a service can do.
 */
export async function captureCase(
  db: Kysely<AppDatabase>,
  ticketId: string,
): Promise<CapturedCase> {
  const ticket = await db
    .selectFrom("tickets")
    .selectAll()
    .where("id", "=", ticketId)
    .executeTakeFirst();
  if (!ticket) throw new Error(`No ticket ${ticketId}`);
  if (ticket.category === "data_deletion") throw new Error("A deletion request is not a case");
  const review = await db
    .selectFrom("ticketReviews")
    .selectAll()
    .where("ticketId", "=", ticketId)
    .executeTakeFirst();
  if (!review) throw new Error(`Ticket ${ticketId} has no staff verdict yet`);
  const customer = await db
    .selectFrom("customers")
    .select(["name", "email"])
    .where("id", "=", ticket.customerId)
    .executeTakeFirstOrThrow();
  const run = await db
    .selectFrom("agentRuns")
    .select("state")
    .where("ticketId", "=", ticketId)
    .executeTakeFirst();
  const tenant = TENANT_SLUGS.find((slug) => CATALOG[slug].tenant.id === ticket.tenantId);
  if (!tenant) throw new Error(`Ticket ${ticketId} belongs to an unknown tenant`);

  // The records the agent read: its first successful look at the invoices.
  const listed = runState
    .parse(run?.state)
    .toolCalls.find((call) => call.tool === "list_invoices" && !call.outcome.isError);
  if (!listed) throw new Error(`The agent read no billing records for ticket ${ticketId}`);
  const records = billingRecords.parse(JSON.parse(listed.outcome.content));

  const at = ticket.createdAt.getTime();
  const age = (iso: string) =>
    Math.max(0, Math.round(((at - Date.parse(iso)) / DAY_MS) * 1e4) / 1e4);
  const position = new Map<string, { invoice: number; payment: number }>();
  records.invoices.forEach((invoice, i) => {
    invoice.payments.forEach((payment, j) => {
      position.set(payment.id, { invoice: i, payment: j });
    });
  });

  let { subject, body } = ticket;
  records.invoices.forEach((invoice, index) => {
    subject = subject.replaceAll(invoice.number, `{{invoice:${index}}}`);
    body = body.replaceAll(invoice.number, `{{invoice:${index}}}`);
  });

  return capturedCase.parse({
    version: 1,
    id: `case_${createHash("sha256").update(ticketId).digest("hex").slice(0, 12)}`,
    tenant,
    textReviewed: false,
    ticket: {
      category: ticket.category,
      subject: scrub(subject, customer),
      body: scrub(body, customer),
    },
    invoices: records.invoices.map((invoice) => ({
      issuedDaysAgo: age(invoice.issuedAt),
      amountCents: invoice.amountCents,
      status: invoice.status,
      payments: invoice.payments.map((payment) => ({
        daysAgo: age(payment.createdAt),
        status: payment.status,
        refunds: payment.refunds.map((refund) => ({
          daysAgo: age(refund.createdAt),
          reason: refund.reason,
          amountCents: refund.amountCents,
        })),
      })),
    })),
    observed: { outcome: ticket.outcome ?? "none", reasonCode: ticket.reasonCode ?? "none" },
    expected: {
      outcome: review.expectedOutcome,
      reasonCode: review.expectedReason,
      refunds: expectedRefunds.parse(review.expectedRefunds).map((refund) => {
        const where = position.get(refund.paymentId);
        if (!where) {
          throw new Error(
            "The verdict names a payment the agent never saw, so it cannot be rebuilt",
          );
        }
        return { ...where, amountCents: refund.amountCents };
      }),
    },
  });
}

const money = (cents: number) => (cents / 100).toFixed(2);

/** Rebuilds a captured case as a scenario, on a fresh customer with the same billing history. */
export function caseToSpec(input: CapturedCase): ScenarioSpec {
  const captured = capturedCase.parse(input);
  if (!captured.textReviewed) {
    throw new Error(`Case ${captured.id} has not been read by a person and cannot be used`);
  }
  return {
    id: captured.id,
    title: `Captured from production: expected ${captured.expected.outcome}`,
    build(b): ScenarioCase {
      const { tenant, plans } = CATALOG[captured.tenant];
      const plan = plans[0];
      if (!plan) throw new Error(`Tenant ${captured.tenant} has no plans`);
      const oldest = Math.max(30, ...captured.invoices.map((invoice) => invoice.issuedDaysAgo));
      const customer = b.customer(captured.tenant, { name: `Case ${captured.id.slice(5, 11)}` });
      const subscription = b.subscription(customer, {
        plan: plan.code,
        startedDaysAgo: Math.ceil(oldest) + 1,
      });

      const built = captured.invoices.map((invoice) => {
        const row = b.invoice(subscription, {
          issuedDaysAgo: invoice.issuedDaysAgo,
          status: invoice.status,
          amountCents: invoice.amountCents,
        });
        const payments = invoice.payments.map((payment) => {
          const paid = b.payment(row, { daysAgo: payment.daysAgo, status: payment.status });
          for (const refund of payment.refunds) b.refund(paid, refund);
          return paid;
        });
        return { row, payments };
      });
      const fill = (text: string) =>
        text.replaceAll(/\{\{invoice:(\d+)\}\}/g, (_match, index: string) => {
          const invoice = built[Number(index)];
          if (!invoice) throw new Error(`Case ${captured.id} refers to a missing invoice`);
          return invoice.row.number;
        });

      const refunds = captured.expected.refunds.map((refund) => {
        const payment = built[refund.invoice]?.payments[refund.payment];
        if (!payment) throw new Error(`Case ${captured.id} refers to a missing payment`);
        return {
          paymentId: payment.id,
          amountCents: refund.amountCents,
          charged: payment.amountCents,
        };
      });
      const total = refunds.reduce((sum, refund) => sum + refund.amountCents, 0);
      // The same rule the policy applies: over the limit in total, or against
      // a payment larger than the limit.
      const needsApproval =
        total > tenant.refundApprovalLimitCents ||
        refunds.some((refund) => refund.charged > tenant.refundApprovalLimitCents);

      return {
        customer,
        ticket: b.ticket(customer, {
          category: captured.ticket.category,
          subject: fill(captured.ticket.subject),
          body: fill(captured.ticket.body),
        }),
        // Only the scripted oracle reads the intent, and captured cases are
        // judged on the staff verdict, not by the oracle.
        intent: {
          reason:
            captured.expected.reasonCode === "duplicate_charge"
              ? "duplicate_charge"
              : "change_of_mind",
          target: "unspecified",
        },
        ...(needsApproval ? { staffDecision: "approved" as const } : {}),
        expected: {
          outcome: captured.expected.outcome as Outcome,
          reasonCode: captured.expected.reasonCode as ScenarioCase["expected"]["reasonCode"],
          refunds: refunds.map(({ paymentId, amountCents }) => ({ paymentId, amountCents })),
          ...(needsApproval ? { approval: { amountCents: total } } : {}),
          reply: { mentions: total > 0 ? [money(total)] : [] },
        },
      };
    },
  };
}
