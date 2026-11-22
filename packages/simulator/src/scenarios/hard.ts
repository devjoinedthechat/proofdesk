import type { ScenarioBuilder } from "../builder.ts";
import type { TenantSlug } from "../catalog.ts";
import type { ScenarioSpec } from "../scenario.ts";
import { account, paidInvoice } from "./helpers.ts";

// Single tickets where the answer depends on rules meeting each other, or on
// a fact the ticket does not state. Each is still decided by the written
// policy alone, so the answer key is not a judgment call. What makes them
// hard is that a plausible reading of the ticket leads somewhere else:
//
// - which payment of several is the one that counts,
// - what is left of a payment after an earlier partial refund,
// - a boundary counted in whole days, or a year counted back from today,
// - a rule that applies to one invoice and not to the customer's others,
// - a number the customer gives relative to what they have.

/** A workspace with an active subscription and two paid invoices, for plan-change tickets. */
function workspace(
  b: ScenarioBuilder,
  slug: TenantSlug,
  name: string,
  plan: string,
  seats: number,
) {
  const customer = b.customer(slug, { name });
  const subscription = b.subscription(customer, { plan, seats, startedDaysAgo: 70 });
  paidInvoice(b, subscription, 40);
  paidInvoice(b, subscription, 10);
  return { customer, subscription };
}

export const HARD_SCENARIOS: ScenarioSpec[] = [
  {
    id: "hard-duplicate-after-declined-attempt",
    title: "A declined attempt, then two successful charges: only the last is the duplicate",
    build(b) {
      const { customer, subscription } = account(b, "harbor", "Rasmus Holt", "team-monthly", 3, 60);
      paidInvoice(b, subscription, 36);
      const invoice = b.invoice(subscription, { issuedDaysAgo: 6 });
      b.payment(invoice, { daysAgo: 6, status: "failed" });
      b.payment(invoice, { daysAgo: 6, minutesLater: 5 });
      const duplicate = b.payment(invoice, { daysAgo: 6, minutesLater: 7 });
      return {
        customer,
        ticket: b.ticket(customer, {
          subject: `Double charge on ${invoice.number}`,
          body: `My card was declined the first time I paid ${invoice.number}, so I tried again, and now my statement shows two charges of $87.00 on the same day. Please refund the extra one.`,
        }),
        intent: { reason: "duplicate_charge", target: { invoiceNumber: invoice.number } },
        expected: {
          outcome: "refunded",
          reasonCode: "duplicate_charge",
          refunds: [{ paymentId: duplicate.id, amountCents: 87_00 }],
          reply: { mentions: ["$87.00", invoice.number] },
        },
      };
    },
  },
  {
    id: "hard-duplicate-partly-returned",
    title: "Part of a duplicate was returned earlier; the rest of it is owed",
    build(b) {
      const { customer, subscription } = account(
        b,
        "tallyfield",
        "Selma Brink",
        "pro-monthly",
        2,
        40,
      );
      const invoice = b.invoice(subscription, { issuedDaysAgo: 8 });
      b.payment(invoice, { daysAgo: 8 });
      const duplicate = b.payment(invoice, { daysAgo: 8, minutesLater: 2 });
      b.refund(duplicate, { daysAgo: 7, reason: "duplicate_charge", amountCents: 30_00 });
      return {
        customer,
        ticket: b.ticket(customer, {
          subject: "Rest of the double charge",
          body: `I was charged twice for ${invoice.number}. Someone sent back $30.00 of it last week, but the second charge was $98.00. Where is the rest?`,
        }),
        intent: { reason: "duplicate_charge", target: { invoiceNumber: invoice.number } },
        expected: {
          outcome: "refunded",
          reasonCode: "duplicate_charge",
          refunds: [{ paymentId: duplicate.id, amountCents: 68_00 }],
          reply: { mentions: ["$68.00", invoice.number] },
        },
      };
    },
  },
  {
    id: "hard-allowance-used-364-days-ago",
    title: "The yearly refund on request was used 364 days ago, which is still inside the year",
    build(b) {
      const { customer, subscription } = account(
        b,
        "harbor",
        "Tobias Wren",
        "starter-monthly",
        1,
        400,
      );
      const earlier = paidInvoice(b, subscription, 370);
      b.refund(earlier.payment, { daysAgo: 364, reason: "customer_request" });
      paidInvoice(b, subscription, 34);
      const { invoice } = paidInvoice(b, subscription, 4);
      return {
        customer,
        ticket: b.ticket(customer, {
          subject: "Refund, please",
          body: `The last time I asked for a refund was about a year ago, so I should be allowed one again. Please refund ${invoice.number}; I have not used the product this month.`,
        }),
        intent: { reason: "change_of_mind", target: { invoiceNumber: invoice.number } },
        expected: {
          outcome: "refused",
          reasonCode: "goodwill_limit_reached",
          refunds: [],
          reply: { mentions: [invoice.number] },
        },
      };
    },
  },
  {
    id: "hard-window-last-hour",
    // Earlier in the day than now, so that the payment is 30 days back both
    // by elapsed time and by calendar date. An earlier version put it later
    // in the day, 31 calendar days back, and the written rule ("counted in
    // whole days") does not say which count it means.
    title: "Paid 30 days and 2 hours ago, at the company whose window is 30 days",
    build(b) {
      const { customer, subscription } = account(
        b,
        "tallyfield",
        "Ulla Fenn",
        "basic-monthly",
        2,
        45,
      );
      const invoice = b.invoice(subscription, { issuedDaysAgo: 30 });
      const payment = b.payment(invoice, { daysAgo: 30, minutesLater: -120 });
      return {
        customer,
        ticket: b.ticket(customer, {
          subject: "Too late for a refund?",
          body: `I paid ${invoice.number} about a month ago and I would like a refund. I expect it is too late, but I thought I would ask.`,
        }),
        intent: { reason: "change_of_mind", target: { invoiceNumber: invoice.number } },
        expected: {
          outcome: "refunded",
          reasonCode: "within_window",
          refunds: [{ paymentId: payment.id, amountCents: 38_00 }],
          reply: { mentions: ["$38.00", invoice.number] },
        },
      };
    },
  },
  {
    id: "hard-window-late-in-day",
    title: "Paid 30 days and 23 hours ago: 31 days back on the calendar, still inside the window",
    build(b) {
      // The prompt counts full 24-hour periods since prompt version
      // 2026-11-22.1. Before that it said "counted in whole days", which
      // a model could read as calendar dates.
      const { customer, subscription } = account(
        b,
        "tallyfield",
        "Ebba Strand",
        "basic-monthly",
        2,
        45,
      );
      const invoice = b.invoice(subscription, { issuedDaysAgo: 31 });
      const payment = b.payment(invoice, { daysAgo: 31, minutesLater: 60 });
      return {
        customer,
        ticket: b.ticket(customer, {
          subject: "Refund before it is too late",
          body: `I paid ${invoice.number} on the 12th of last month and would like a refund. Am I still in time?`,
        }),
        intent: { reason: "change_of_mind", target: { invoiceNumber: invoice.number } },
        expected: {
          outcome: "refunded",
          reasonCode: "within_window",
          refunds: [{ paymentId: payment.id, amountCents: 38_00 }],
          reply: { mentions: ["$38.00", invoice.number] },
        },
      };
    },
  },
  {
    id: "hard-latest-attempt-declined",
    title: "Asks for the latest payment back; the latest attempt was declined",
    build(b) {
      const { customer, subscription } = account(
        b,
        "tallyfield",
        "Vera Holm",
        "pro-monthly",
        1,
        60,
      );
      paidInvoice(b, subscription, 50);
      const { invoice, payment } = paidInvoice(b, subscription, 20);
      const declined = b.invoice(subscription, { issuedDaysAgo: 1 });
      b.payment(declined, { daysAgo: 1, status: "failed" });
      return {
        customer,
        ticket: b.ticket(customer, {
          subject: "Refund my last payment",
          body: "We are moving to another tool. Please refund the last payment I made to you.",
        }),
        intent: { reason: "change_of_mind", target: "latest" },
        expected: {
          outcome: "refunded",
          reasonCode: "within_window",
          refunds: [{ paymentId: payment.id, amountCents: 49_00 }],
          reply: { mentions: ["$49.00", invoice.number] },
        },
      };
    },
  },
  {
    id: "hard-dispute-on-another-invoice",
    title: "A bank dispute on an older invoice does not stop a refund on this one",
    build(b) {
      const { customer, subscription } = account(b, "harbor", "Willem Dahl", "team-monthly", 2, 70);
      const older = b.invoice(subscription, { issuedDaysAgo: 34 });
      b.payment(older, { daysAgo: 34, status: "disputed" });
      const { invoice, payment } = paidInvoice(b, subscription, 6);
      return {
        customer,
        ticket: b.ticket(customer, {
          subject: `Refund for ${invoice.number}`,
          body: `I have a separate dispute open with my bank about ${older.number}, which they are handling. That is not what this is about. I would like a refund for ${invoice.number}, which I paid last week by mistake.`,
        }),
        intent: { reason: "change_of_mind", target: { invoiceNumber: invoice.number } },
        expected: {
          outcome: "refunded",
          reasonCode: "within_window",
          refunds: [{ paymentId: payment.id, amountCents: 58_00 }],
          reply: { mentions: ["$58.00", invoice.number] },
        },
      };
    },
  },
  {
    id: "hard-duplicate-under-dispute",
    title: "A real duplicate, but the customer has disputed it with their bank",
    build(b) {
      const { customer, subscription } = account(
        b,
        "tallyfield",
        "Xenia Lark",
        "pro-monthly",
        1,
        40,
      );
      paidInvoice(b, subscription, 35);
      const invoice = b.invoice(subscription, { issuedDaysAgo: 5 });
      b.payment(invoice, { daysAgo: 5 });
      b.payment(invoice, { daysAgo: 5, minutesLater: 1, status: "disputed" });
      return {
        customer,
        ticket: b.ticket(customer, {
          subject: "Charged twice",
          body: `I was charged twice for ${invoice.number}. I have asked my bank to reverse the second charge, but it would be quicker if you refunded it yourselves.`,
        }),
        intent: { reason: "duplicate_charge", target: { invoiceNumber: invoice.number } },
        expected: {
          outcome: "handed_to_staff",
          reasonCode: "dispute_open",
          refunds: [],
          reply: { mentions: [invoice.number] },
        },
      };
    },
  },
  {
    id: "hard-asks-more-than-remains",
    title: "Asks for a set amount, which is more than is left after an earlier credit",
    build(b) {
      const { customer, subscription } = account(
        b,
        "tallyfield",
        "Yrsa Moen",
        "basic-monthly",
        3,
        40,
      );
      const { invoice, payment } = paidInvoice(b, subscription, 9);
      b.refund(payment, { daysAgo: 5, reason: "service_credit", amountCents: 25_00 });
      return {
        customer,
        ticket: b.ticket(customer, {
          subject: "Partial refund",
          body: `We only used Tallyfield for a few days this month. Please refund $40.00 of ${invoice.number}.`,
        }),
        intent: {
          reason: "change_of_mind",
          target: { invoiceNumber: invoice.number },
          amountCents: 40_00,
        },
        expected: {
          outcome: "refunded",
          reasonCode: "within_window",
          refunds: [{ paymentId: payment.id, amountCents: 32_00 }],
          reply: { mentions: ["$32.00", invoice.number] },
        },
      };
    },
  },
  {
    id: "hard-old-duplicate",
    title: "A duplicate from seven months ago: duplicates have no time limit",
    build(b) {
      const { customer, subscription } = account(
        b,
        "harbor",
        "Ziggy Brandt",
        "business-monthly",
        1,
        260,
      );
      const invoice = b.invoice(subscription, { issuedDaysAgo: 200 });
      b.payment(invoice, { daysAgo: 200 });
      const duplicate = b.payment(invoice, { daysAgo: 200, minutesLater: 3 });
      paidInvoice(b, subscription, 50);
      paidInvoice(b, subscription, 20);
      return {
        customer,
        ticket: b.ticket(customer, {
          subject: "Old double charge",
          body: `I only just noticed, going through last year's statements, that ${invoice.number} was charged twice. I know it was a long time ago. Is there anything you can do?`,
        }),
        intent: { reason: "duplicate_charge", target: { invoiceNumber: invoice.number } },
        expected: {
          outcome: "refunded",
          reasonCode: "duplicate_charge",
          refunds: [{ paymentId: duplicate.id, amountCents: 50_00 }],
          reply: { mentions: ["$50.00", invoice.number] },
        },
      };
    },
  },
  {
    id: "hard-triple-one-returned",
    title: "Charged three times; one of the extra charges was already returned",
    build(b) {
      const { customer, subscription } = account(b, "harbor", "Agnes Pihl", "team-monthly", 1, 30);
      const invoice = b.invoice(subscription, { issuedDaysAgo: 10 });
      b.payment(invoice, { daysAgo: 10 });
      const returned = b.payment(invoice, { daysAgo: 10, minutesLater: 1 });
      const third = b.payment(invoice, { daysAgo: 10, minutesLater: 2 });
      b.refund(returned, { daysAgo: 9, reason: "duplicate_charge" });
      return {
        customer,
        ticket: b.ticket(customer, {
          subject: "Still overcharged",
          body: `You refunded one of the extra charges on ${invoice.number}, thank you, but I was charged three times, not twice.`,
        }),
        intent: { reason: "duplicate_charge", target: { invoiceNumber: invoice.number } },
        expected: {
          outcome: "refunded",
          reasonCode: "duplicate_charge",
          refunds: [{ paymentId: third.id, amountCents: 29_00 }],
          reply: { mentions: ["$29.00", invoice.number] },
        },
      };
    },
  },
  {
    id: "hard-one-open-duplicate",
    title: "No invoice named; of two double charges only one is still unrefunded",
    build(b) {
      const { customer, subscription } = account(
        b,
        "tallyfield",
        "Birgit Lund",
        "basic-monthly",
        1,
        60,
      );
      const earlier = b.invoice(subscription, { issuedDaysAgo: 40 });
      b.payment(earlier, { daysAgo: 40 });
      const earlierDuplicate = b.payment(earlier, { daysAgo: 40, minutesLater: 2 });
      b.refund(earlierDuplicate, { daysAgo: 38, reason: "duplicate_charge" });
      const invoice = b.invoice(subscription, { issuedDaysAgo: 8 });
      b.payment(invoice, { daysAgo: 8 });
      const duplicate = b.payment(invoice, { daysAgo: 8, minutesLater: 1 });
      return {
        customer,
        ticket: b.ticket(customer, {
          subject: "Charged twice again",
          body: "This is the second time you have taken my payment twice. Please refund the extra charge.",
        }),
        intent: { reason: "duplicate_charge", target: "unspecified" },
        expected: {
          outcome: "refunded",
          reasonCode: "duplicate_charge",
          refunds: [{ paymentId: duplicate.id, amountCents: 19_00 }],
          reply: { mentions: ["$19.00", invoice.number] },
        },
      };
    },
  },
  {
    id: "hard-plan-exactly-fifty-seats",
    title: "Fifty seats is the most support may set, and is allowed",
    build(b) {
      const { customer, subscription } = workspace(b, "harbor", "Casper Rye", "team-monthly", 20);
      return {
        customer,
        ticket: b.ticket(customer, {
          subject: "More seats",
          body: "We are growing. Please take our Team plan to 50 seats. If that needs a sales call, tell me.",
          category: "plan_change",
        }),
        intent: { kind: "plan_change", seats: 50 },
        expected: {
          outcome: "plan_changed",
          reasonCode: "plan_changed",
          refunds: [],
          planChange: { subscriptionId: subscription.id, planCode: "team-monthly", seats: 50 },
          reply: { mentions: ["50"] },
        },
      };
    },
  },
  {
    id: "hard-plan-relative-seats",
    title: "Asks for three more seats, without saying how many that makes",
    build(b) {
      const { customer, subscription } = workspace(b, "tallyfield", "Dorit Haag", "pro-monthly", 6);
      return {
        customer,
        ticket: b.ticket(customer, {
          subject: "Three more seats",
          body: "Three new people start on Monday. Please add three seats to our plan.",
          category: "plan_change",
        }),
        intent: { kind: "plan_change", seats: 9 },
        expected: {
          outcome: "plan_changed",
          reasonCode: "plan_changed",
          refunds: [],
          planChange: { subscriptionId: subscription.id, planCode: "pro-monthly", seats: 9 },
          reply: { mentions: ["9"] },
        },
      };
    },
  },
];
