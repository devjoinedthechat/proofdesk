// Any refund against a payment larger than the approval limit needs approval,
// however small the refund. Without this, a refund above the limit could be
// asked for in parts, and the first part would be paid before anyone looked.
forbid (principal, action == Action::"create_refund", resource)
when { context.paymentAmountCents > resource.approvalLimitCents && !context.approved };
