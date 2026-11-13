// The agent may search the help centre for any ticket that concerns billing.
// What it can find there is limited separately, by the search itself.
permit (principal, action == Action::"search_help_center", resource)
when { resource.category == "refund" || resource.category == "plan_change" };
