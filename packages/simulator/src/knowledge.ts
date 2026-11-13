import type { TenantSlug } from "./catalog.ts";

export type KnowledgeDocument = {
  tenant: TenantSlug;
  visibility: "public" | "internal";
  title: string;
  sourceUri: string;
  markdown: string;
};

// The two companies' help centres, plus a few staff-only pages. None of this
// decides whether a refund is allowed: those rules are in the agent's prompt
// and in the policy layer. These pages hold what a customer asks about around
// a refund: how long it takes, how to cancel, what a plan includes.

const harbor: Omit<KnowledgeDocument, "tenant">[] = [
  {
    visibility: "public",
    title: "When your refund arrives",
    sourceUri: "help/refund-timing",
    markdown: `# When your refund arrives

## Card payments

A refund goes back to the card that was charged. Harbor Notes sends it the same day it is approved. Your bank then takes 5 to 10 business days to show it on your statement.

## If the card has expired or was replaced

The refund still goes to the same card account. Your bank moves it to your new card. If the account was closed, the bank returns the money to us and we contact you within 14 days to arrange a bank transfer.

## Refunds that needed approval

Refunds above a certain amount are checked by a member of our team before they are sent. This usually takes one working day and never more than three.`,
  },
  {
    visibility: "public",
    title: "Cancelling your subscription",
    sourceUri: "help/cancelling",
    markdown: `# Cancelling your subscription

## How to cancel

Open Settings, choose Billing, and select Cancel subscription. Only a workspace owner can cancel. Cancelling stops the next renewal. It does not refund the current period by itself.

## What happens to your notes

Your notes stay readable until the end of the period you paid for. After that the workspace becomes read-only for 60 days, and is then deleted. You can export everything as Markdown at any time from Settings, Export.

## Cancelling an annual plan

An annual plan runs to the end of its year after you cancel. It will not renew.`,
  },
  {
    visibility: "public",
    title: "Plans and what they include",
    sourceUri: "help/plans",
    markdown: `# Plans and what they include

## Starter

Starter costs $12 per seat each month. It includes unlimited notes, sync across two devices per person, and 30 days of version history.

## Team

Team costs $29 per seat each month, or $290 per seat each year. It adds shared notebooks, sync across unlimited devices, one year of version history, and guest access for people outside your company.

## Business

Business costs $50 per seat each month. It adds single sign-on with SAML, an audit log of workspace activity, and a dedicated region for your data.

## Which plan has single sign-on

Single sign-on is only part of the Business plan. Starter and Team workspaces sign in with email and password or with Google.`,
  },
  {
    visibility: "public",
    title: "How billing works",
    sourceUri: "help/billing-cycle",
    markdown: `# How billing works

## Monthly plans

You are charged on the day you subscribe and on the same day each month after that. Each charge has its own invoice. Two invoices a month apart are two separate months, not a duplicate.

## Adding and removing seats

Seats you add are charged straight away for the rest of the current period. Seats you remove stop being charged from the next renewal.

## Failed payments

If a charge fails we try the card again after one day and after three days. A failed attempt appears on your bank's app as a pending transaction for a few days and then disappears. It is not a second charge.

## Invoice reference

You can add your own reference, such as a purchase order number, to an invoice at checkout. It is printed on the invoice exactly as you typed it.`,
  },
  {
    visibility: "public",
    title: "Sync problems",
    sourceUri: "help/sync-problems",
    markdown: `# Sync problems

## Notes not appearing on another device

Check that both devices are signed in to the same workspace. Then open Settings, Sync, and choose Sync now. Most delays clear within a minute.

## Reporting an outage

If sync stays broken for more than an hour, check status.harbornotes.example for a known incident. If none is listed, contact support and tell us the device, the app version, and when the problem started.

## Credit for outages

If a confirmed outage kept you from using Harbor Notes, tell support which days were affected. We review each case.`,
  },
  {
    visibility: "internal",
    title: "Support runbook: refund exceptions",
    sourceUri: "internal/refund-exceptions",
    markdown: `# Support runbook: refund exceptions

## Who can make an exception

Only a support lead can approve a refund outside the published window. The automated agent cannot. Leads may extend the window to 45 days for customers on an annual plan who were affected by a confirmed outage.

## Recording an exception

Record the incident number and the lead's name on the ticket. Exceptions are reviewed monthly by finance.

## Escalation contacts

Billing escalations go to the finance queue. Legal threats go to the legal queue and are never answered by support.`,
  },
  {
    visibility: "internal",
    title: "Support runbook: disputes and chargebacks",
    sourceUri: "internal/disputes",
    markdown: `# Support runbook: disputes and chargebacks

## While a dispute is open

Never refund a payment that is under a bank dispute. The bank decides, and a refund on top would pay the customer twice. Reply that the dispute is with their bank and give the expected timeline of 30 to 75 days.

## After a dispute is decided

If the bank sides with us, the charge stands. If it sides with the customer, the bank returns the money and we close the invoice.`,
  },
];

const tallyfield: Omit<KnowledgeDocument, "tenant">[] = [
  {
    visibility: "public",
    title: "Refund timing",
    sourceUri: "help/refund-timing",
    markdown: `# Refund timing

## How long a refund takes

Tallyfield returns refunds to the original payment method. Card refunds reach your statement in 3 to 5 business days. Refunds to a bank debit take up to 8 business days.

## Large refunds

A refund of a larger amount is reviewed by our billing team first, normally within two working days.

## Checking on a refund

Every refund has a line on the invoice it belongs to. Open Billing, Invoices, and select the invoice to see the date and the amount.`,
  },
  {
    visibility: "public",
    title: "Cancel or pause",
    sourceUri: "help/cancel-or-pause",
    markdown: `# Cancel or pause

## Cancelling

Go to Account, Subscription, Cancel plan. Any admin can cancel. Your dashboards stay available until the paid period ends.

## Pausing instead

You can pause a monthly plan for up to three months from the same page. A paused plan is not charged and keeps your data. Annual plans cannot be paused.

## Data after cancelling

We keep your reports for 90 days after the plan ends so you can come back. After 90 days they are deleted. Export to CSV is available from every report.`,
  },
  {
    visibility: "public",
    title: "Tallyfield plans",
    sourceUri: "help/plans",
    markdown: `# Tallyfield plans

## Basic

Basic is $19 per seat each month. It includes five dashboards, daily data refresh, and CSV export.

## Pro

Pro is $49 per seat each month or $490 per seat each year. It includes unlimited dashboards, hourly data refresh, scheduled reports by email, and API access.

## Scheduled reports

Scheduled reports are a Pro feature. They are sent at the time you choose, in the time zone of the workspace. A report that fails to send is retried twice and then listed under Reports, Delivery log.`,
  },
  {
    visibility: "public",
    title: "Understanding your invoices",
    sourceUri: "help/invoices",
    markdown: `# Understanding your invoices

## One invoice per period

Monthly plans produce one invoice a month and annual plans one a year. If you see two charges a month apart, they are two periods.

## Seat changes

Extra seats appear as a separate line on your next invoice, charged from the day they were added.

## Tax

Prices exclude tax. Tax is added at checkout according to your billing address and shown on each invoice.`,
  },
  {
    visibility: "internal",
    title: "Billing team runbook: approvals",
    sourceUri: "internal/approvals",
    markdown: `# Billing team runbook: approvals

## What needs approval

Refunds above the approval threshold wait for a member of the billing team. Approve when the records support the customer's account. Decline when the refund is outside policy, and say why on the ticket.

## Annual renewals charged twice

A double charge on an annual renewal is always approved once the second payment is confirmed in the records. Aim to decide these the same day.`,
  },
];

export const KNOWLEDGE_BASE: KnowledgeDocument[] = [
  ...harbor.map((document) => ({ tenant: "harbor" as const, ...document })),
  ...tallyfield.map((document) => ({ tenant: "tallyfield" as const, ...document })),
];
