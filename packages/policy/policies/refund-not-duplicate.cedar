// A refund for a duplicate charge must be against a payment that really is a
// later duplicate. Calling a refund "duplicate" does not escape the window.
forbid (principal, action == Action::"create_refund", resource)
when { context.reason == "duplicate_charge" && !context.isLaterDuplicate };
