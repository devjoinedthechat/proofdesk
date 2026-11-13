-- migrate:up
-- The billing service connects as billing_app, which can read billing data and
-- append refunds. It cannot change or delete anything, whatever the code does.
CREATE FUNCTION app_tenant_matches(row_tenant text) RETURNS boolean
  LANGUAGE sql STABLE
  RETURN row_tenant = current_setting('app.tenant_id', true);

CREATE FUNCTION app_customer_matches(row_customer text) RETURNS boolean
  LANGUAGE sql STABLE
  RETURN current_setting('app.customer_id', true) = '*'
      OR row_customer = current_setting('app.customer_id', true);

ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE refunds ENABLE ROW LEVEL SECURITY;

CREATE POLICY billing_plans ON plans FOR SELECT TO billing_app
  USING (app_tenant_matches(tenant_id));
CREATE POLICY billing_subscriptions ON subscriptions FOR SELECT TO billing_app
  USING (app_tenant_matches(tenant_id) AND app_customer_matches(customer_id));
CREATE POLICY billing_invoices ON invoices FOR SELECT TO billing_app
  USING (app_tenant_matches(tenant_id) AND app_customer_matches(customer_id));
CREATE POLICY billing_payments ON payments FOR SELECT TO billing_app
  USING (app_tenant_matches(tenant_id) AND app_customer_matches(customer_id));

-- A refund is visible, and can be created, only when its payment is visible.
-- The subquery runs under the payments policy above.
CREATE POLICY billing_refunds ON refunds TO billing_app
  USING (
    app_tenant_matches(tenant_id)
    AND EXISTS (SELECT 1 FROM payments WHERE payments.id = refunds.payment_id)
  )
  WITH CHECK (
    app_tenant_matches(tenant_id)
    AND EXISTS (SELECT 1 FROM payments WHERE payments.id = refunds.payment_id)
  );

GRANT SELECT ON plans, subscriptions, invoices, payments, refunds TO billing_app;
GRANT INSERT ON refunds TO billing_app;
-- SELECT ... FOR UPDATE on a payment needs UPDATE privilege, on one column
-- that the service never writes.
GRANT UPDATE (status) ON payments TO billing_app;
CREATE POLICY billing_payments_lock ON payments FOR UPDATE TO billing_app
  USING (app_tenant_matches(tenant_id) AND app_customer_matches(customer_id))
  WITH CHECK (false);

-- migrate:down
DROP POLICY billing_payments_lock ON payments;
DROP POLICY billing_refunds ON refunds;
DROP POLICY billing_payments ON payments;
DROP POLICY billing_invoices ON invoices;
DROP POLICY billing_subscriptions ON subscriptions;
DROP POLICY billing_plans ON plans;
ALTER TABLE refunds DISABLE ROW LEVEL SECURITY;
ALTER TABLE payments DISABLE ROW LEVEL SECURITY;
ALTER TABLE invoices DISABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions DISABLE ROW LEVEL SECURITY;
ALTER TABLE plans DISABLE ROW LEVEL SECURITY;
REVOKE ALL ON plans, subscriptions, invoices, payments, refunds FROM billing_app;
DROP FUNCTION app_customer_matches;
DROP FUNCTION app_tenant_matches;
