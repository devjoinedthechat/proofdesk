// A large number of seats is a sales conversation, not a support ticket.
forbid (principal, action == Action::"change_plan", resource)
when { context.seats < 1 || context.seats > 50 };
