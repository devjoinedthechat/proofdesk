// The agent's refunds for one company may total at most that company's cap
// in any 24 hours. Past it, every further refund needs a member of staff,
// however ordinary it looks by itself.
forbid (principal, action == Action::"create_refund", resource)
when
{
  context.tenantRefundedTodayCents + context.amountCents > resource.dailyRefundCapCents &&
  !context.approved
};
