// On a refund ticket the agent may issue refunds. Every other refund policy
// is a limit on this one.
permit (principal, action == Action::"create_refund", resource)
when { resource.category == "refund" && context.amountCents > 0 };
