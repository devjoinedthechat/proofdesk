// A ticket's refunds may total at most the tenant's limit, unless a member of
// staff approved this call.
forbid (principal, action == Action::"create_refund", resource)
when
{
  context.ticketRefundedCents + context.amountCents > resource.approvalLimitCents &&
  !context.approved
};
