-- migrate:up
-- A reviewer has to see the billing records the agent saw, to say which
-- refund should have been made. The portal may read a run's state inside the
-- reviewer's own tenant, and still cannot write one.
CREATE POLICY portal_runs ON agent_runs FOR SELECT TO portal_app
  USING (app_tenant_matches(tenant_id) AND app_customer_matches(customer_id));
GRANT SELECT (ticket_id, tenant_id, customer_id, state) ON agent_runs TO portal_app;

-- migrate:down
REVOKE SELECT (ticket_id, tenant_id, customer_id, state) ON agent_runs FROM portal_app;
DROP POLICY portal_runs ON agent_runs;
