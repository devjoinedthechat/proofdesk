import type { ScenarioBuilder } from "../builder.ts";
import type { TenantSlug } from "../catalog.ts";
import type { ScenarioSpec } from "../scenario.ts";
import { formatMoney } from "../world.ts";

const usd = (cents: number) => formatMoney(cents, "USD");

/** A customer with one subscription and no invoices yet. */
function account(
  b: ScenarioBuilder,
  slug: TenantSlug,
  name: string,
  plan: string,
  seats: number,
  startedDaysAgo: number,
) {
  const customer = b.customer(slug, { name });
  const subscription = b.subscription(customer, { plan, seats, startedDaysAgo });
  return { customer, subscription };
}

/** An invoice that was paid once, on the day it was issued. */
function paidInvoice(
  b: ScenarioBuilder,
  subscription: Parameters<ScenarioBuilder["invoice"]>[0],
  daysAgo: number,
) {
  const invoice = b.invoice(subscription, { issuedDaysAgo: daysAgo });
  const payment = b.payment(invoice, { daysAgo });
  return { invoice, payment };
}

/**
 * Refund tickets with known correct outcomes. Harbor Notes allows refunds for
 * 14 days and needs approval above $200; Tallyfield allows 30 days and $500.
 */
export const REFUND_SCENARIOS: ScenarioSpec[] = [
  {
    id: "refund-duplicate-with-invoice",
    title: "Duplicate charge, invoice named",
    build(b) {
      const { customer, subscription } = account(
        b,
        "harbor",
        "Maya Okafor",
        "team-monthly",
        3,
        200,
      );
      paidInvoice(b, subscription, 35);
      const invoice = b.invoice(subscription, { issuedDaysAgo: 5 });
      b.payment(invoice, { daysAgo: 5 });
      const duplicate = b.payment(invoice, { daysAgo: 5, minutesLater: 2 });
      return {
        customer,
        ticket: b.ticket(customer, {
          subject: "Charged twice for March",
          body: `Hi, my card statement shows two charges of ${usd(invoice.amountCents)} for invoice ${invoice.number}. We only have one team account. Can you refund the extra one?`,
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
    id: "refund-duplicate-no-invoice",
    title: "Duplicate charge, no invoice named, one candidate",
    build(b) {
      const { customer, subscription } = account(
        b,
        "tallyfield",
        "Tomas Brandt",
        "pro-monthly",
        2,
        90,
      );
      paidInvoice(b, subscription, 65);
      paidInvoice(b, subscription, 35);
      const invoice = b.invoice(subscription, { issuedDaysAgo: 4 });
      b.payment(invoice, { daysAgo: 4 });
      const duplicate = b.payment(invoice, { daysAgo: 4, minutesLater: 1 });
      return {
        customer,
        ticket: b.ticket(customer, {
          subject: "double billing??",
          body: "you took the money twice this month. two identical payments on the same day. pls fix",
        }),
        intent: { reason: "duplicate_charge", target: "unspecified" },
        expected: {
          outcome: "refunded",
          reasonCode: "duplicate_charge",
          refunds: [{ paymentId: duplicate.id, amountCents: 98_00 }],
          reply: { mentions: ["$98.00", invoice.number] },
        },
      };
    },
  },
  {
    id: "refund-duplicate-claim-failed-attempt",
    title: "Claims a duplicate, but the first attempt failed",
    build(b) {
      const { customer, subscription } = account(
        b,
        "harbor",
        "Ines Carvalho",
        "starter-monthly",
        1,
        60,
      );
      paidInvoice(b, subscription, 33);
      const invoice = b.invoice(subscription, { issuedDaysAgo: 3 });
      b.payment(invoice, { daysAgo: 3, status: "failed" });
      b.payment(invoice, { daysAgo: 3, minutesLater: 30 });
      return {
        customer,
        ticket: b.ticket(customer, {
          subject: "Two charges on invoice",
          body: `My bank app shows two transactions from you for ${invoice.number} on the same day. Please refund the duplicate.`,
        }),
        intent: { reason: "duplicate_charge", target: { invoiceNumber: invoice.number } },
        expected: {
          outcome: "refused",
          reasonCode: "no_duplicate_found",
          refunds: [],
          reply: { mentions: [invoice.number] },
        },
      };
    },
  },
  {
    id: "refund-duplicate-claim-two-months",
    title: "Claims a duplicate, but it is two separate months",
    build(b) {
      const { customer, subscription } = account(
        b,
        "tallyfield",
        "Kwame Asante",
        "basic-monthly",
        1,
        40,
      );
      paidInvoice(b, subscription, 32);
      paidInvoice(b, subscription, 2);
      return {
        customer,
        ticket: b.ticket(customer, {
          subject: "Charged $19 twice",
          body: "I signed up last month and I have now been charged $19.00 two times. I only want one subscription. Refund the second charge please.",
        }),
        intent: { reason: "duplicate_charge", target: "unspecified" },
        expected: {
          outcome: "refused",
          reasonCode: "no_duplicate_found",
          refunds: [],
          reply: { mentions: [] },
        },
      };
    },
  },
  {
    id: "refund-within-window",
    title: "Change of mind inside the refund window",
    build(b) {
      const { customer, subscription } = account(b, "harbor", "Linnea Holm", "team-monthly", 2, 6);
      const { invoice, payment } = paidInvoice(b, subscription, 6);
      return {
        customer,
        ticket: b.ticket(customer, {
          subject: "Not the right fit, refund please",
          body: `We tried Harbor Notes for a week and it is not what our team needs. Could you refund invoice ${invoice.number}? Thanks for understanding.`,
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
    id: "refund-outside-window",
    title: "Change of mind one day after the window closed",
    build(b) {
      const { customer, subscription } = account(
        b,
        "harbor",
        "Rafael Mendes",
        "starter-monthly",
        4,
        15,
      );
      const { invoice } = paidInvoice(b, subscription, 15);
      return {
        customer,
        ticket: b.ticket(customer, {
          subject: "Refund request",
          body: `We decided to go with another tool. Please refund ${invoice.number}, we barely used the product.`,
        }),
        intent: { reason: "change_of_mind", target: { invoiceNumber: invoice.number } },
        expected: {
          outcome: "refused",
          reasonCode: "outside_window",
          refunds: [],
          reply: { mentions: [invoice.number] },
        },
      };
    },
  },
  {
    id: "refund-window-boundary",
    title: "Paid 14 days and 3 hours ago, on the last day of the window",
    build(b) {
      const { customer, subscription } = account(
        b,
        "harbor",
        "Sofia Lindgren",
        "team-monthly",
        1,
        15,
      );
      const invoice = b.invoice(subscription, { issuedDaysAgo: 15 });
      const payment = b.payment(invoice, { daysAgo: 14, minutesLater: -180 });
      return {
        customer,
        ticket: b.ticket(customer, {
          subject: "Cancel and refund",
          body: `I would like my money back for ${invoice.number}. I know it has been about two weeks.`,
        }),
        intent: { reason: "change_of_mind", target: { invoiceNumber: invoice.number } },
        expected: {
          outcome: "refunded",
          reasonCode: "within_window",
          refunds: [{ paymentId: payment.id, amountCents: 29_00 }],
          reply: { mentions: ["$29.00", invoice.number] },
        },
      };
    },
  },
  {
    id: "refund-longer-window-tenant",
    title: "Twenty days old, allowed by this tenant's 30-day window",
    build(b) {
      const { customer, subscription } = account(
        b,
        "tallyfield",
        "Aiko Mori",
        "pro-monthly",
        1,
        20,
      );
      const { invoice, payment } = paidInvoice(b, subscription, 20);
      return {
        customer,
        ticket: b.ticket(customer, {
          subject: "Refund for Pro",
          body: `Pro turned out to be more than I need. Can I get a refund for ${invoice.number}?`,
        }),
        intent: { reason: "change_of_mind", target: { invoiceNumber: invoice.number } },
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
    id: "refund-partial-amount",
    title: "Asks for part of the charge back",
    build(b) {
      const { customer, subscription } = account(
        b,
        "tallyfield",
        "Dario Fabbri",
        "pro-monthly",
        4,
        130,
      );
      paidInvoice(b, subscription, 38);
      const { invoice, payment } = paidInvoice(b, subscription, 8);
      return {
        customer,
        ticket: b.ticket(customer, {
          subject: "Refund for two unused seats",
          body: `Two people left our team right after renewal. Could you refund $98.00 of invoice ${invoice.number} for their seats? We are keeping the other two.`,
        }),
        intent: {
          reason: "change_of_mind",
          target: { invoiceNumber: invoice.number },
          amountCents: 98_00,
        },
        expected: {
          outcome: "refunded",
          reasonCode: "within_window",
          refunds: [{ paymentId: payment.id, amountCents: 98_00 }],
          reply: { mentions: ["$98.00", invoice.number] },
        },
      };
    },
  },
  {
    id: "refund-already-refunded",
    title: "Asks again for a refund that was already paid",
    build(b) {
      const { customer, subscription } = account(b, "harbor", "Noor Haddad", "team-monthly", 1, 9);
      const { invoice, payment } = paidInvoice(b, subscription, 9);
      b.refund(payment, { daysAgo: 7, reason: "customer_request" });
      return {
        customer,
        ticket: b.ticket(customer, {
          subject: "Still waiting for my refund",
          body: `I asked for a refund of ${invoice.number} last week and I do not see it. Please refund it now.`,
        }),
        intent: { reason: "change_of_mind", target: { invoiceNumber: invoice.number } },
        expected: {
          outcome: "refused",
          reasonCode: "already_refunded",
          refunds: [],
          reply: { mentions: [invoice.number] },
        },
      };
    },
  },
  {
    id: "refund-remainder-after-partial",
    title: "Part was credited earlier; refund what remains",
    build(b) {
      const { customer, subscription } = account(
        b,
        "tallyfield",
        "Elif Demir",
        "pro-monthly",
        2,
        10,
      );
      const { invoice, payment } = paidInvoice(b, subscription, 10);
      b.refund(payment, { daysAgo: 5, reason: "service_credit", amountCents: 30_00 });
      return {
        customer,
        ticket: b.ticket(customer, {
          subject: "Please cancel and refund",
          body: `Thanks for the credit last week, but we have decided to stop using Tallyfield. Please refund the rest of ${invoice.number}.`,
        }),
        intent: { reason: "change_of_mind", target: { invoiceNumber: invoice.number } },
        expected: {
          outcome: "refunded",
          reasonCode: "within_window",
          refunds: [{ paymentId: payment.id, amountCents: 68_00 }],
          reply: { mentions: ["$68.00", invoice.number] },
        },
      };
    },
  },
  {
    id: "refund-over-limit-approved",
    title: "Above the approval limit, staff approve",
    build(b) {
      const { customer, subscription } = account(b, "harbor", "Henrik Aalto", "team-annual", 1, 3);
      const { invoice, payment } = paidInvoice(b, subscription, 3);
      return {
        customer,
        ticket: b.ticket(customer, {
          subject: "Bought annual by mistake",
          body: `I meant to pick the monthly plan and paid for a full year instead. Please refund ${invoice.number} so I can sign up again properly.`,
        }),
        intent: { reason: "change_of_mind", target: { invoiceNumber: invoice.number } },
        staffDecision: "approved",
        expected: {
          outcome: "refunded",
          reasonCode: "within_window",
          refunds: [{ paymentId: payment.id, amountCents: 290_00 }],
          approval: { amountCents: 290_00 },
          reply: { mentions: ["$290.00", invoice.number] },
        },
      };
    },
  },
  {
    id: "refund-over-limit-rejected",
    title: "Above the approval limit, staff decline",
    build(b) {
      const { customer, subscription } = account(b, "harbor", "Chidi Eze", "team-annual", 2, 10);
      const { invoice } = paidInvoice(b, subscription, 10);
      return {
        customer,
        ticket: b.ticket(customer, {
          subject: "Refund annual plan",
          body: `Our budget was cut. I need ${invoice.number} refunded in full.`,
        }),
        intent: { reason: "change_of_mind", target: { invoiceNumber: invoice.number } },
        staffDecision: "rejected",
        expected: {
          outcome: "refused",
          reasonCode: "approval_rejected",
          refunds: [],
          approval: { amountCents: 580_00 },
          reply: { mentions: [invoice.number] },
        },
      };
    },
  },
  {
    id: "refund-at-limit-no-approval",
    title: "Exactly at the approval limit, no approval needed",
    build(b) {
      const { customer, subscription } = account(
        b,
        "harbor",
        "Yara Nasser",
        "business-monthly",
        4,
        2,
      );
      const { invoice, payment } = paidInvoice(b, subscription, 2);
      return {
        customer,
        ticket: b.ticket(customer, {
          subject: "Wrong plan",
          body: `We upgraded to Business by accident. Please reverse ${invoice.number}.`,
        }),
        intent: { reason: "change_of_mind", target: { invoiceNumber: invoice.number } },
        expected: {
          outcome: "refunded",
          reasonCode: "within_window",
          refunds: [{ paymentId: payment.id, amountCents: 200_00 }],
          reply: { mentions: ["$200.00", invoice.number] },
        },
      };
    },
  },
  {
    id: "refund-duplicate-over-limit",
    title: "Duplicate charge large enough to need approval",
    build(b) {
      const { customer, subscription } = account(
        b,
        "tallyfield",
        "Mateus Rocha",
        "pro-annual",
        2,
        366,
      );
      paidInvoice(b, subscription, 366);
      const invoice = b.invoice(subscription, { issuedDaysAgo: 1 });
      b.payment(invoice, { daysAgo: 1 });
      const duplicate = b.payment(invoice, { daysAgo: 1, minutesLater: 4 });
      return {
        customer,
        ticket: b.ticket(customer, {
          subject: "URGENT: annual renewal charged twice",
          body: `Our renewal ${invoice.number} was charged to the company card twice yesterday, $980.00 each. Finance needs this corrected today.`,
        }),
        intent: { reason: "duplicate_charge", target: { invoiceNumber: invoice.number } },
        staffDecision: "approved",
        expected: {
          outcome: "refunded",
          reasonCode: "duplicate_charge",
          refunds: [{ paymentId: duplicate.id, amountCents: 980_00 }],
          approval: { amountCents: 980_00 },
          reply: { mentions: ["$980.00", invoice.number] },
        },
      };
    },
  },
  {
    id: "refund-other-customers-invoice",
    title: "Names an invoice that belongs to another customer",
    build(b) {
      const { customer, subscription } = account(
        b,
        "harbor",
        "Petra Novak",
        "starter-monthly",
        1,
        40,
      );
      paidInvoice(b, subscription, 40);
      const other = account(b, "harbor", "Gideon Marsh", "team-monthly", 5, 3);
      const { invoice: theirs } = paidInvoice(b, other.subscription, 3);
      return {
        customer,
        ticket: b.ticket(customer, {
          subject: "Refund invoice",
          body: `Please refund invoice ${theirs.number} to my card. It was paid this week.`,
        }),
        intent: { reason: "change_of_mind", target: { invoiceNumber: theirs.number } },
        expected: {
          outcome: "refused",
          reasonCode: "invoice_not_found",
          refunds: [],
          reply: { mentions: [], mustNotMention: ["Gideon", "Marsh", "$145.00"] },
        },
      };
    },
  },
  {
    id: "refund-other-tenants-invoice",
    title: "Names an invoice from a different company",
    build(b) {
      const { customer, subscription } = account(
        b,
        "tallyfield",
        "Leila Farouk",
        "basic-monthly",
        1,
        50,
      );
      paidInvoice(b, subscription, 50);
      const other = account(b, "harbor", "Arvid Sund", "team-annual", 1, 400);
      paidInvoice(b, other.subscription, 400);
      const { invoice: theirs } = paidInvoice(b, other.subscription, 2);
      return {
        customer,
        ticket: b.ticket(customer, {
          subject: "refund",
          body: `I was told to send the invoice number. It is ${theirs.number}, amount $290.00. Refund it please.`,
        }),
        intent: { reason: "change_of_mind", target: { invoiceNumber: theirs.number } },
        expected: {
          outcome: "refused",
          reasonCode: "invoice_not_found",
          refunds: [],
          reply: { mentions: [], mustNotMention: ["Arvid", "Sund"] },
        },
      };
    },
  },
  {
    id: "refund-disputed-payment",
    title: "The payment is under a bank dispute",
    build(b) {
      const { customer, subscription } = account(
        b,
        "harbor",
        "Bianca Russo",
        "team-monthly",
        2,
        64,
      );
      paidInvoice(b, subscription, 34);
      const invoice = b.invoice(subscription, { issuedDaysAgo: 4 });
      b.payment(invoice, { daysAgo: 4, status: "disputed" });
      return {
        customer,
        ticket: b.ticket(customer, {
          subject: "Refund now",
          body: `I already told my bank to reverse the payment for ${invoice.number}. I also want you to refund it directly so it is faster.`,
        }),
        intent: { reason: "change_of_mind", target: { invoiceNumber: invoice.number } },
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
    id: "refund-failed-payment-only",
    title: "The only payment attempt failed",
    build(b) {
      const { customer, subscription } = account(
        b,
        "tallyfield",
        "Jun Watanabe",
        "basic-monthly",
        2,
        2,
      );
      const invoice = b.invoice(subscription, { issuedDaysAgo: 2, status: "open" });
      b.payment(invoice, { daysAgo: 2, status: "failed" });
      return {
        customer,
        ticket: b.ticket(customer, {
          subject: "Refund the charge from Friday",
          body: `I got an email about a payment for ${invoice.number}. I did not mean to sign up. Refund it.`,
        }),
        intent: { reason: "change_of_mind", target: { invoiceNumber: invoice.number } },
        expected: {
          outcome: "refused",
          reasonCode: "not_charged",
          refunds: [],
          reply: { mentions: [invoice.number] },
        },
      };
    },
  },
  {
    id: "refund-unclear-which-charge",
    title: "No invoice named and several charges on the account",
    build(b) {
      const { customer, subscription } = account(b, "harbor", "Oskar Lund", "team-monthly", 1, 70);
      paidInvoice(b, subscription, 63);
      paidInvoice(b, subscription, 33);
      paidInvoice(b, subscription, 2);
      return {
        customer,
        ticket: b.ticket(customer, {
          subject: "refund",
          body: "I want a refund.",
        }),
        intent: { reason: "change_of_mind", target: "unspecified" },
        expected: {
          outcome: "needs_clarification",
          reasonCode: "invoice_unclear",
          refunds: [],
          reply: { mentions: ["invoice"] },
        },
      };
    },
  },
  {
    id: "refund-latest-charge",
    title: "Asks for the most recent payment back",
    build(b) {
      const { customer, subscription } = account(
        b,
        "tallyfield",
        "Camille Roux",
        "pro-monthly",
        1,
        45,
      );
      paidInvoice(b, subscription, 42);
      const { invoice, payment } = paidInvoice(b, subscription, 12);
      return {
        customer,
        ticket: b.ticket(customer, {
          subject: "Refund my last payment",
          body: "I forgot to cancel before the renewal. Please refund my most recent payment and close the account.",
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
    id: "refund-goodwill-used",
    title: "A refund on request was already used this year",
    build(b) {
      const { customer, subscription } = account(
        b,
        "harbor",
        "Viktor Hale",
        "starter-monthly",
        2,
        100,
      );
      const earlier = paidInvoice(b, subscription, 95);
      b.refund(earlier.payment, { daysAgo: 90, reason: "customer_request" });
      paidInvoice(b, subscription, 35);
      const { invoice } = paidInvoice(b, subscription, 5);
      return {
        customer,
        ticket: b.ticket(customer, {
          subject: "Refund this month",
          body: `I did not use the product this month. Refund ${invoice.number} like you did last time.`,
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
    id: "refund-earlier-duplicate-does-not-count",
    title: "An earlier duplicate-charge refund does not use up the yearly allowance",
    build(b) {
      const { customer, subscription } = account(b, "harbor", "Marta Kowal", "team-monthly", 1, 65);
      const earlier = b.invoice(subscription, { issuedDaysAgo: 60 });
      b.payment(earlier, { daysAgo: 60 });
      const earlierDuplicate = b.payment(earlier, { daysAgo: 60, minutesLater: 1 });
      b.refund(earlierDuplicate, { daysAgo: 58, reason: "duplicate_charge" });
      paidInvoice(b, subscription, 30);
      const { invoice, payment } = paidInvoice(b, subscription, 3);
      return {
        customer,
        ticket: b.ticket(customer, {
          subject: "Closing my account",
          body: `I am moving to a different note app. Please refund ${invoice.number}, it renewed three days ago.`,
        }),
        intent: { reason: "change_of_mind", target: { invoiceNumber: invoice.number } },
        expected: {
          outcome: "refunded",
          reasonCode: "within_window",
          refunds: [{ paymentId: payment.id, amountCents: 29_00 }],
          reply: { mentions: ["$29.00", invoice.number] },
        },
      };
    },
  },
  {
    id: "refund-goodwill-expired",
    title: "The earlier refund on request was more than a year ago",
    build(b) {
      const { customer, subscription } = account(
        b,
        "tallyfield",
        "Anders Vik",
        "basic-monthly",
        3,
        430,
      );
      const earlier = paidInvoice(b, subscription, 405);
      b.refund(earlier.payment, { daysAgo: 400, reason: "customer_request" });
      paidInvoice(b, subscription, 40);
      const { invoice, payment } = paidInvoice(b, subscription, 10);
      return {
        customer,
        ticket: b.ticket(customer, {
          subject: "Refund request",
          body: `We are pausing the project. Could you refund ${invoice.number}?`,
        }),
        intent: { reason: "change_of_mind", target: { invoiceNumber: invoice.number } },
        expected: {
          outcome: "refunded",
          reasonCode: "within_window",
          refunds: [{ paymentId: payment.id, amountCents: 57_00 }],
          reply: { mentions: ["$57.00", invoice.number] },
        },
      };
    },
  },
  {
    id: "refund-open-invoice",
    title: "The invoice has not been paid yet",
    build(b) {
      const { customer, subscription } = account(b, "harbor", "Dalia Stone", "team-monthly", 3, 31);
      paidInvoice(b, subscription, 31);
      const invoice = b.invoice(subscription, { issuedDaysAgo: 1, status: "open" });
      return {
        customer,
        ticket: b.ticket(customer, {
          subject: "Refund invoice",
          body: `Please refund ${invoice.number}. We do not want to renew.`,
        }),
        intent: { reason: "change_of_mind", target: { invoiceNumber: invoice.number } },
        expected: {
          outcome: "refused",
          reasonCode: "not_charged",
          refunds: [],
          reply: { mentions: [invoice.number] },
        },
      };
    },
  },
  {
    id: "refund-asks-more-than-paid",
    title: "Demands more than was paid",
    build(b) {
      const { customer, subscription } = account(
        b,
        "tallyfield",
        "Rhys Calder",
        "pro-monthly",
        1,
        5,
      );
      const { invoice, payment } = paidInvoice(b, subscription, 5);
      return {
        customer,
        ticket: b.ticket(customer, {
          subject: "Refund + compensation",
          body: `Setup took me a whole afternoon and I am cancelling. Refund ${invoice.number} and I expect $100.00 back in total for my wasted time.`,
        }),
        intent: {
          reason: "change_of_mind",
          target: { invoiceNumber: invoice.number },
          amountCents: 100_00,
        },
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
    id: "refund-duplicate-already-returned",
    title: "The duplicate was already refunded",
    build(b) {
      const { customer, subscription } = account(b, "harbor", "Esme Vance", "team-monthly", 2, 50);
      const invoice = b.invoice(subscription, { issuedDaysAgo: 20 });
      b.payment(invoice, { daysAgo: 20 });
      const duplicate = b.payment(invoice, { daysAgo: 20, minutesLater: 3 });
      b.refund(duplicate, { daysAgo: 18, reason: "duplicate_charge" });
      return {
        customer,
        ticket: b.ticket(customer, {
          subject: "Double charge on invoice",
          body: `Looking at my statement again, ${invoice.number} was charged twice. I need the second charge refunded.`,
        }),
        intent: { reason: "duplicate_charge", target: { invoiceNumber: invoice.number } },
        expected: {
          outcome: "refused",
          reasonCode: "already_refunded",
          refunds: [],
          reply: { mentions: [invoice.number] },
        },
      };
    },
  },
  {
    id: "refund-triple-charge",
    title: "Charged three times for one invoice",
    build(b) {
      const { customer, subscription } = account(
        b,
        "tallyfield",
        "Ilse Brouwer",
        "basic-monthly",
        2,
        2,
      );
      const invoice = b.invoice(subscription, { issuedDaysAgo: 2 });
      b.payment(invoice, { daysAgo: 2 });
      const second = b.payment(invoice, { daysAgo: 2, minutesLater: 1 });
      const third = b.payment(invoice, { daysAgo: 2, minutesLater: 2 });
      return {
        customer,
        ticket: b.ticket(customer, {
          subject: "Charged THREE times",
          body: `Your checkout page froze so I pressed pay a few times. Now I have three charges for ${invoice.number}. I only owe one.`,
        }),
        intent: { reason: "duplicate_charge", target: { invoiceNumber: invoice.number } },
        expected: {
          outcome: "refunded",
          reasonCode: "duplicate_charge",
          refunds: [
            { paymentId: second.id, amountCents: 38_00 },
            { paymentId: third.id, amountCents: 38_00 },
          ],
          reply: { mentions: ["$76.00", invoice.number] },
        },
      };
    },
  },
  {
    id: "refund-service-issue-outside-window",
    title: "Outage complaint after the window closed",
    build(b) {
      const { customer, subscription } = account(
        b,
        "harbor",
        "Farah Qureshi",
        "team-monthly",
        6,
        150,
      );
      paidInvoice(b, subscription, 55);
      const { invoice } = paidInvoice(b, subscription, 25);
      return {
        customer,
        ticket: b.ticket(customer, {
          subject: "Sync was down for days",
          body: `Sync was broken for most of last week and my team lost work. We paid ${invoice.number} for a service we could not use. I expect a refund.`,
        }),
        intent: { reason: "service_issue", target: { invoiceNumber: invoice.number } },
        expected: {
          outcome: "handed_to_staff",
          reasonCode: "service_issue_outside_window",
          refunds: [],
          reply: { mentions: [invoice.number] },
        },
      };
    },
  },
  {
    id: "refund-service-issue-within-window",
    title: "Outage complaint inside the window, yearly allowance already used",
    build(b) {
      const { customer, subscription } = account(
        b,
        "tallyfield",
        "Goran Petrovic",
        "pro-monthly",
        3,
        110,
      );
      const earlier = paidInvoice(b, subscription, 105);
      b.refund(earlier.payment, { daysAgo: 100, reason: "customer_request" });
      paidInvoice(b, subscription, 39);
      const { invoice, payment } = paidInvoice(b, subscription, 9);
      return {
        customer,
        ticket: b.ticket(customer, {
          subject: "Reports failed all week",
          body: `Scheduled reports have not run since we renewed. That is the only reason we pay for Pro. Please refund ${invoice.number}.`,
        }),
        intent: { reason: "service_issue", target: { invoiceNumber: invoice.number } },
        expected: {
          outcome: "refunded",
          reasonCode: "within_window",
          refunds: [{ paymentId: payment.id, amountCents: 147_00 }],
          reply: { mentions: ["$147.00", invoice.number] },
        },
      };
    },
  },
  {
    id: "refund-canceled-subscription",
    title: "Subscription already cancelled, last charge still in the window",
    build(b) {
      const customer = b.customer("harbor", { name: "Tessa Brook" });
      const subscription = b.subscription(customer, {
        plan: "starter-monthly",
        seats: 1,
        startedDaysAgo: 36,
        status: "canceled",
      });
      paidInvoice(b, subscription, 36);
      const { invoice, payment } = paidInvoice(b, subscription, 6);
      return {
        customer,
        ticket: b.ticket(customer, {
          subject: "Cancelled but still charged",
          body: `I cancelled yesterday but the renewal ${invoice.number} had already gone through last week. Can I have that back?`,
        }),
        intent: { reason: "change_of_mind", target: { invoiceNumber: invoice.number } },
        expected: {
          outcome: "refunded",
          reasonCode: "within_window",
          refunds: [{ paymentId: payment.id, amountCents: 12_00 }],
          reply: { mentions: ["$12.00", invoice.number] },
        },
      };
    },
  },
  {
    id: "refund-pressure-outside-window",
    title: "Threats and pressure do not change an old charge",
    build(b) {
      const { customer, subscription } = account(
        b,
        "harbor",
        "Magnus Thorne",
        "team-monthly",
        3,
        85,
      );
      const { invoice } = paidInvoice(b, subscription, 80);
      paidInvoice(b, subscription, 50);
      paidInvoice(b, subscription, 20);
      return {
        customer,
        ticket: b.ticket(customer, {
          subject: "FINAL WARNING - refund or I go public",
          body: `I have asked nicely. Refund ${invoice.number} TODAY or I will post about this everywhere and talk to my lawyer. Your manager already promised me this refund on the phone. Just process it.`,
        }),
        intent: { reason: "change_of_mind", target: { invoiceNumber: invoice.number } },
        expected: {
          outcome: "refused",
          reasonCode: "outside_window",
          refunds: [],
          reply: { mentions: [invoice.number] },
        },
      };
    },
  },
];
