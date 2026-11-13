-- migrate:up
-- A change of plan or seats on a subscription. Each change records what it
-- replaced, so it can be undone exactly if the other half of a two-system
-- change fails.
CREATE TABLE plan_changes (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  customer_id text NOT NULL,
  subscription_id text NOT NULL REFERENCES subscriptions (id),
  from_plan_id text NOT NULL REFERENCES plans (id),
  from_seats integer NOT NULL,
  to_plan_id text NOT NULL REFERENCES plans (id),
  to_seats integer NOT NULL,
  status text NOT NULL CHECK (status IN ('applied', 'reverted')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  reverted_at timestamptz,
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL,
  UNIQUE (tenant_id, idempotency_key)
);

ALTER TABLE plan_changes ENABLE ROW LEVEL SECURITY;

CREATE POLICY billing_plan_changes ON plan_changes TO billing_app
  USING (app_tenant_matches(tenant_id) AND app_customer_matches(customer_id))
  WITH CHECK (app_tenant_matches(tenant_id) AND app_customer_matches(customer_id));
GRANT SELECT, INSERT ON plan_changes TO billing_app;
GRANT UPDATE (status, reverted_at) ON plan_changes TO billing_app;

-- The service may change which plan and how many seats a subscription has,
-- and nothing else about it.
GRANT UPDATE (plan_id, seats) ON subscriptions TO billing_app;
CREATE POLICY billing_subscriptions_change ON subscriptions FOR UPDATE TO billing_app
  USING (app_tenant_matches(tenant_id) AND app_customer_matches(customer_id))
  WITH CHECK (app_tenant_matches(tenant_id) AND app_customer_matches(customer_id));

-- migrate:down
DROP POLICY billing_subscriptions_change ON subscriptions;
REVOKE UPDATE (plan_id, seats) ON subscriptions FROM billing_app;
DROP TABLE plan_changes;
