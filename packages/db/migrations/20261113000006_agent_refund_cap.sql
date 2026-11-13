-- migrate:up
-- The most the agent may refund for a tenant in any 24 hours without staff
-- approving each further refund. It limits what a fooled model can do across
-- many tickets, where every single refund is within the per-ticket rules.
-- Zero means every refund needs approval.
ALTER TABLE tenants
  ADD COLUMN agent_daily_refund_cap_cents integer NOT NULL DEFAULT 0
    CHECK (agent_daily_refund_cap_cents >= 0);

-- Every refund the agent made, by the id billing gave it. One row per refund
-- however often the step that made it is repeated.
CREATE TABLE agent_refunds (
  refund_id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants (id),
  ticket_id text NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  created_at timestamptz NOT NULL
);

CREATE INDEX agent_refunds_tenant_idx ON agent_refunds (tenant_id, created_at);

ALTER TABLE agent_refunds ENABLE ROW LEVEL SECURITY;

-- The total is per tenant, across customers, so the rule is on the tenant only.
CREATE POLICY worker_agent_refunds ON agent_refunds TO worker_app
  USING (app_tenant_matches(tenant_id))
  WITH CHECK (app_tenant_matches(tenant_id));

GRANT SELECT, INSERT ON agent_refunds TO worker_app;

-- migrate:down
DROP TABLE agent_refunds;
ALTER TABLE tenants DROP COLUMN agent_daily_refund_cap_cents;
