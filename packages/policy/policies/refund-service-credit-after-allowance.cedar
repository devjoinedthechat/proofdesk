// A refund for a service fault is not counted against the yearly refund on
// request, because a fault is not the customer's choice. But no record says
// whether a fault happened: the customer says so, and the model believes it.
// Once the yearly refund has been used, "it was a fault" is the way round the
// limit, so a service credit then needs a member of staff.
forbid (principal, action == Action::"create_refund", resource)
when { context.reason == "service_credit" && context.goodwillUsed && !context.approved };
