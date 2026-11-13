-- migrate:up
ALTER TABLE tickets
  ADD COLUMN category text NOT NULL DEFAULT 'refund'
  CHECK (category IN ('refund', 'plan_change', 'data_deletion'));
ALTER TABLE tickets ALTER COLUMN category DROP DEFAULT;

CREATE TABLE ticket_grants (
  ticket_id text PRIMARY KEY REFERENCES tickets (id),
  tenant_id text NOT NULL REFERENCES tenants (id),
  customer_id text NOT NULL REFERENCES customers (id),
  scopes text[] NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE TABLE grant_assertions (
  jti text PRIMARY KEY,
  ticket_id text NOT NULL REFERENCES ticket_grants (ticket_id),
  tenant_id text NOT NULL,
  scope text NOT NULL,
  issued_to text NOT NULL,
  issued_at timestamptz NOT NULL
);

-- Row-level security. The policies read two transaction-local settings.
-- With neither set, both functions yield no match, so access fails closed.
CREATE FUNCTION app_tenant_matches(row_tenant text) RETURNS boolean
  LANGUAGE sql STABLE
  RETURN row_tenant = current_setting('app.tenant_id', true);

CREATE FUNCTION app_customer_matches(row_customer text) RETURNS boolean
  LANGUAGE sql STABLE
  RETURN current_setting('app.customer_id', true) = '*'
      OR row_customer = current_setting('app.customer_id', true);

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE grant_assertions ENABLE ROW LEVEL SECURITY;

-- portal_app serves signed-in customers and staff, always inside one tenant.
CREATE POLICY portal_tenants ON tenants FOR SELECT TO portal_app
  USING (app_tenant_matches(id));
CREATE POLICY portal_customers ON customers FOR SELECT TO portal_app
  USING (app_tenant_matches(tenant_id) AND app_customer_matches(id));
CREATE POLICY portal_tickets ON tickets TO portal_app
  USING (app_tenant_matches(tenant_id) AND app_customer_matches(customer_id))
  WITH CHECK (app_tenant_matches(tenant_id) AND app_customer_matches(customer_id));
CREATE POLICY portal_grants ON ticket_grants TO portal_app
  USING (app_tenant_matches(tenant_id) AND app_customer_matches(customer_id))
  WITH CHECK (app_tenant_matches(tenant_id) AND app_customer_matches(customer_id));

GRANT SELECT ON tenants, customers TO portal_app;
GRANT SELECT, INSERT ON tickets, ticket_grants TO portal_app;
GRANT UPDATE (revoked_at) ON ticket_grants TO portal_app;

-- grants_app signs assertions for the agent. It works across tenants, so it
-- gets the narrowest table access instead: read grants and ticket status,
-- append to the assertion log, nothing else.
CREATE POLICY grants_read_tickets ON tickets FOR SELECT TO grants_app USING (true);
CREATE POLICY grants_read_grants ON ticket_grants FOR SELECT TO grants_app USING (true);
CREATE POLICY grants_log ON grant_assertions FOR INSERT TO grants_app WITH CHECK (true);

GRANT SELECT (id, status) ON tickets TO grants_app;
GRANT SELECT ON ticket_grants TO grants_app;
GRANT INSERT ON grant_assertions TO grants_app;

-- migrate:down
DROP TABLE grant_assertions;
DROP TABLE ticket_grants;
ALTER TABLE tickets DROP COLUMN category;
ALTER TABLE tickets DISABLE ROW LEVEL SECURITY;
ALTER TABLE customers DISABLE ROW LEVEL SECURITY;
ALTER TABLE tenants DISABLE ROW LEVEL SECURITY;
DROP FUNCTION app_customer_matches;
DROP FUNCTION app_tenant_matches;
