// Except for duplicate charges, a refund is allowed only within the tenant's
// refund window. Approval does not extend the window.
forbid (principal, action == Action::"create_refund", resource)
when
{
  context.reason != "duplicate_charge" &&
  context.daysSincePayment > resource.refundWindowDays
};
