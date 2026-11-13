// On a plan-change ticket the agent may change the customer's plan or seats,
// and read what the workspace is currently entitled to. Which plans exist,
// and whether the subscription can be changed, are checked by billing.
permit (
  principal,
  action in [Action::"change_plan", Action::"get_entitlement"],
  resource
)
when { resource.category == "plan_change" };
