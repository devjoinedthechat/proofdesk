// Above the limit, a refund needs a member of staff to approve this call.
permit (principal, action == Action::"create_refund", resource)
when { resource.category == "refund" && context.amountCents > 0 && context.approved };
