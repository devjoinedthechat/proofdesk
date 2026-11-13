import type { TenantSlug } from "./catalog.ts";

/**
 * Questions with a known answer in the knowledge base. `phrase` is text that
 * appears only in the passage that answers the question. `wording` says how
 * the question relates to that passage: `shared` uses its words, `paraphrase`
 * deliberately avoids them, `exact` hinges on one specific term.
 */
export type KnowledgeQuestion = {
  tenant: TenantSlug;
  audience: "public" | "internal";
  question: string;
  sourceUri: string;
  phrase: string;
  wording: "shared" | "paraphrase" | "exact";
};

export const KNOWLEDGE_QUESTIONS: KnowledgeQuestion[] = [
  // Harbor Notes, public
  {
    tenant: "harbor",
    audience: "public",
    wording: "shared",
    question: "How many business days does a card refund take to show on my statement?",
    sourceUri: "help/refund-timing",
    phrase: "5 to 10 business days",
  },
  {
    tenant: "harbor",
    audience: "public",
    wording: "paraphrase",
    question: "When will I get my money back?",
    sourceUri: "help/refund-timing",
    phrase: "5 to 10 business days",
  },
  {
    tenant: "harbor",
    audience: "public",
    wording: "shared",
    question: "My card expired, where does the refund go?",
    sourceUri: "help/refund-timing",
    phrase: "moves it to your new card",
  },
  {
    tenant: "harbor",
    audience: "public",
    wording: "paraphrase",
    question: "Why is my large reimbursement taking longer than usual?",
    sourceUri: "help/refund-timing",
    phrase: "checked by a member of our team",
  },
  {
    tenant: "harbor",
    audience: "public",
    wording: "shared",
    question: "How do I cancel my subscription?",
    sourceUri: "help/cancelling",
    phrase: "select Cancel subscription",
  },
  {
    tenant: "harbor",
    audience: "public",
    wording: "paraphrase",
    question: "Will I lose what I wrote if I stop paying?",
    sourceUri: "help/cancelling",
    phrase: "read-only for 60 days",
  },
  {
    tenant: "harbor",
    audience: "public",
    wording: "exact",
    question: "Does Harbor Notes support SAML?",
    sourceUri: "help/plans",
    phrase: "single sign-on with SAML",
  },
  {
    tenant: "harbor",
    audience: "public",
    wording: "paraphrase",
    question: "Can my company log in through our identity provider on the Team tier?",
    sourceUri: "help/plans",
    phrase: "only part of the Business plan",
  },
  {
    tenant: "harbor",
    audience: "public",
    wording: "shared",
    question: "What does the Starter plan cost per seat?",
    sourceUri: "help/plans",
    phrase: "$12 per seat",
  },
  {
    tenant: "harbor",
    audience: "public",
    wording: "shared",
    question: "I see two invoices a month apart, is that a duplicate?",
    sourceUri: "help/billing-cycle",
    phrase: "two separate months, not a duplicate",
  },
  {
    tenant: "harbor",
    audience: "public",
    wording: "paraphrase",
    question: "My bank app shows a pending transaction that later vanished. Was I billed twice?",
    sourceUri: "help/billing-cycle",
    phrase: "It is not a second charge",
  },
  {
    tenant: "harbor",
    audience: "public",
    wording: "shared",
    question: "When are added seats charged?",
    sourceUri: "help/billing-cycle",
    phrase: "charged straight away",
  },
  {
    tenant: "harbor",
    audience: "public",
    wording: "exact",
    question: "Where can I add a purchase order number to an invoice?",
    sourceUri: "help/billing-cycle",
    phrase: "purchase order number",
  },
  {
    tenant: "harbor",
    audience: "public",
    wording: "paraphrase",
    question: "My pages are not showing up on my phone.",
    sourceUri: "help/sync-problems",
    phrase: "choose Sync now",
  },
  {
    tenant: "harbor",
    audience: "public",
    wording: "shared",
    question: "Can I get credit for an outage?",
    sourceUri: "help/sync-problems",
    phrase: "tell support which days were affected",
  },
  // Harbor Notes, internal
  {
    tenant: "harbor",
    audience: "internal",
    wording: "shared",
    question: "Who can approve a refund outside the published window?",
    sourceUri: "internal/refund-exceptions",
    phrase: "Only a support lead",
  },
  {
    tenant: "harbor",
    audience: "internal",
    wording: "paraphrase",
    question: "Where do I send a customer who says they will take us to court?",
    sourceUri: "internal/refund-exceptions",
    phrase: "legal queue",
  },
  {
    tenant: "harbor",
    audience: "internal",
    wording: "shared",
    question: "Can I refund a payment that is under a bank dispute?",
    sourceUri: "internal/disputes",
    phrase: "pay the customer twice",
  },
  // Tallyfield, public
  {
    tenant: "tallyfield",
    audience: "public",
    wording: "shared",
    question: "How long does a card refund take?",
    sourceUri: "help/refund-timing",
    phrase: "3 to 5 business days",
  },
  {
    tenant: "tallyfield",
    audience: "public",
    wording: "paraphrase",
    question: "Where can I see whether my money was sent back?",
    sourceUri: "help/refund-timing",
    phrase: "Every refund has a line on the invoice",
  },
  {
    tenant: "tallyfield",
    audience: "public",
    wording: "shared",
    question: "Can I pause my plan instead of cancelling?",
    sourceUri: "help/cancel-or-pause",
    phrase: "up to three months",
  },
  {
    tenant: "tallyfield",
    audience: "public",
    wording: "paraphrase",
    question: "How long do you hold on to my dashboards after I leave?",
    sourceUri: "help/cancel-or-pause",
    phrase: "90 days after the plan ends",
  },
  {
    tenant: "tallyfield",
    audience: "public",
    wording: "shared",
    question: "Which plan includes scheduled reports?",
    sourceUri: "help/plans",
    phrase: "Scheduled reports are a Pro feature",
  },
  {
    tenant: "tallyfield",
    audience: "public",
    wording: "exact",
    question: "Is there API access?",
    sourceUri: "help/plans",
    phrase: "API access",
  },
  {
    tenant: "tallyfield",
    audience: "public",
    wording: "paraphrase",
    question: "My weekly email with the numbers never came.",
    sourceUri: "help/plans",
    phrase: "Delivery log",
  },
  {
    tenant: "tallyfield",
    audience: "public",
    wording: "shared",
    question: "Are prices shown with tax?",
    sourceUri: "help/invoices",
    phrase: "Prices exclude tax",
  },
  {
    tenant: "tallyfield",
    audience: "public",
    wording: "paraphrase",
    question: "I was billed again four weeks after the first time, is that an error?",
    sourceUri: "help/invoices",
    phrase: "they are two periods",
  },
  // Tallyfield, internal
  {
    tenant: "tallyfield",
    audience: "internal",
    wording: "shared",
    question: "Should I approve a double charge on an annual renewal?",
    sourceUri: "internal/approvals",
    phrase: "always approved once the second payment is confirmed",
  },
];
