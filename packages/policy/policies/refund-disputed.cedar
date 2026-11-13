// An invoice with a payment under a bank dispute is for staff to handle.
forbid (principal, action == Action::"create_refund", resource)
when { context.invoiceDisputed };
