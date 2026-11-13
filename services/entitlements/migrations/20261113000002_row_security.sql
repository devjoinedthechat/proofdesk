-- migrate:up
CREATE FUNCTION app_tenant_matches(row_tenant text) RETURNS boolean
  LANGUAGE sql STABLE
  RETURN row_tenant = current_setting('app.tenant_id', true);

CREATE FUNCTION app_customer_matches(row_customer text) RETURNS boolean
  LANGUAGE sql STABLE
  RETURN current_setting('app.customer_id', true) = '*'
      OR row_customer = current_setting('app.customer_id', true);

ALTER TABLE entitlements ENABLE ROW LEVEL SECURITY;

CREATE POLICY entitlements_rows ON entitlements TO entitlements_app
  USING (app_tenant_matches(tenant_id) AND app_customer_matches(customer_id))
  WITH CHECK (app_tenant_matches(tenant_id) AND app_customer_matches(customer_id));

GRANT SELECT, UPDATE ON entitlements TO entitlements_app;

-- migrate:down
DROP POLICY entitlements_rows ON entitlements;
ALTER TABLE entitlements DISABLE ROW LEVEL SECURITY;
REVOKE ALL ON entitlements FROM entitlements_app;
DROP FUNCTION app_customer_matches;
DROP FUNCTION app_tenant_matches;
