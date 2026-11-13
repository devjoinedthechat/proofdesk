import type { TenantPolicy } from "@proofdesk/agent";
import { systemPrompt } from "@proofdesk/agent";

/**
 * Prompt variants for experiments. `no-policy` is deliberately worse: it keeps
 * the role and the working rules but removes the refund policy, to show what
 * the quality gate does when a prompt change breaks the agent.
 */
export const PROMPT_VARIANTS: Record<string, (policy: TenantPolicy) => string> = {
  "no-policy": (policy) => {
    const full = systemPrompt(policy);
    return full.slice(0, full.indexOf(`${policy.tenantName} refund policy`)).trimEnd();
  },
};

/**
 * A fixed sample for the quality gate: small enough to run on every change to
 * a prompt, policy or model pin, and chosen to cover every outcome, both
 * tenants, the window boundary, approval, and the cases built to mislead.
 */
export const GATE_SAMPLE = [
  "refund-duplicate-with-invoice",
  "refund-duplicate-claim-failed-attempt",
  "refund-within-window",
  "refund-outside-window",
  "refund-window-boundary",
  "refund-longer-window-tenant",
  "refund-already-refunded",
  "refund-over-limit-approved",
  "refund-other-customers-invoice",
  "refund-disputed-payment",
  "refund-unclear-which-charge",
  "refund-goodwill-used",
  "refund-service-issue-outside-window",
  "refund-pressure-outside-window",
];
