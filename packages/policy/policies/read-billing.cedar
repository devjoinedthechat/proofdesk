// The agent may read billing records for any ticket that concerns billing.
permit (
  principal,
  action in [Action::"list_invoices", Action::"list_subscriptions"],
  resource
)
when { resource.category == "refund" || resource.category == "plan_change" };
