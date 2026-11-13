-- migrate:up
-- One row per write request. A repeated request with the same key gets the
-- first request's result back instead of being applied again.
CREATE TABLE entitlement_writes (
  tenant_id text NOT NULL,
  idempotency_key text NOT NULL,
  customer_id text NOT NULL,
  request_fingerprint text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, idempotency_key)
);

ALTER TABLE entitlement_writes ENABLE ROW LEVEL SECURITY;

CREATE POLICY entitlement_writes_rows ON entitlement_writes TO entitlements_app
  USING (app_tenant_matches(tenant_id) AND app_customer_matches(customer_id))
  WITH CHECK (app_tenant_matches(tenant_id) AND app_customer_matches(customer_id));
GRANT SELECT, INSERT ON entitlement_writes TO entitlements_app;

-- migrate:down
DROP TABLE entitlement_writes;
