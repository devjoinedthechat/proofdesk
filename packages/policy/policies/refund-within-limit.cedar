// On a refund ticket, the agent may refund by itself while the ticket's
// running total stays within the tenant's approval limit.
permit (principal, action == Action::"create_refund", resource)
when
{
  resource.category == "refund" &&
  context.amountCents > 0 &&
  context.ticketRefundedCents + context.amountCents <= resource.approvalLimitCents
};
