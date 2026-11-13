// The payment must be one the billing records show for this customer.
forbid (principal, action == Action::"create_refund", resource)
unless { context.paymentFound };
