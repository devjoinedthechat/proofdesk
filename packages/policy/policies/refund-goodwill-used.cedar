// One refund on request per customer in any 365 days.
forbid (principal, action == Action::"create_refund", resource)
when { context.reason == "customer_request" && context.goodwillUsed };
