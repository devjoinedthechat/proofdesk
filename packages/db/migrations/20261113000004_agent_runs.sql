-- migrate:up
ALTER TABLE tickets
  ADD COLUMN outcome text,
  ADD COLUMN reason_code text,
  ADD COLUMN reply text,
  ADD COLUMN resolved_at timestamptz;

-- The state of the agent's work on one ticket, saved after every step. The
-- workflow engine's own history holds only identifiers and step numbers; the
-- conversation lives here, where it can be deleted with the customer's data.
CREATE TABLE agent_runs (
  ticket_id text PRIMARY KEY REFERENCES tickets (id),
  tenant_id text NOT NULL REFERENCES tenants (id),
  customer_id text NOT NULL REFERENCES customers (id),
  -- Number of completed steps. A step is applied only if this matches, so a
  -- retried step is recognised and not applied twice.
  step integer NOT NULL,
  state jsonb NOT NULL,
  tools jsonb NOT NULL,
  last_output jsonb,
  -- The model, prompt and policy versions this run is pinned to.
  versions jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE approvals (
  id text PRIMARY KEY,
  ticket_id text NOT NULL REFERENCES tickets (id),
  tenant_id text NOT NULL REFERENCES tenants (id),
  customer_id text NOT NULL REFERENCES customers (id),
  step integer NOT NULL,
  tool text NOT NULL,
  -- What staff are asked to approve: identifiers and amounts.
  summary jsonb NOT NULL,
  reason text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  requested_at timestamptz NOT NULL,
  decided_at timestamptz,
  decided_by text,
  UNIQUE (ticket_id, step)
);

-- Model spend per ticket and per tenant, so budgets survive a worker restart.
CREATE TABLE spend (
  key text PRIMARY KEY,
  micros bigint NOT NULL CHECK (micros >= 0)
);

ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;

-- The worker handles every tenant's tickets, but one ticket at a time: each
-- of its transactions is scoped to that ticket's tenant and customer.
CREATE POLICY worker_tenants ON tenants FOR SELECT TO worker_app
  USING (app_tenant_matches(id));
CREATE POLICY worker_tickets ON tickets TO worker_app
  USING (app_tenant_matches(tenant_id) AND app_customer_matches(customer_id))
  WITH CHECK (app_tenant_matches(tenant_id) AND app_customer_matches(customer_id));
CREATE POLICY worker_runs ON agent_runs TO worker_app
  USING (app_tenant_matches(tenant_id) AND app_customer_matches(customer_id))
  WITH CHECK (app_tenant_matches(tenant_id) AND app_customer_matches(customer_id));
CREATE POLICY worker_approvals ON approvals TO worker_app
  USING (app_tenant_matches(tenant_id) AND app_customer_matches(customer_id))
  WITH CHECK (app_tenant_matches(tenant_id) AND app_customer_matches(customer_id));

GRANT SELECT ON tenants TO worker_app;
GRANT SELECT ON tickets TO worker_app;
GRANT UPDATE (status, outcome, reason_code, reply, resolved_at) ON tickets TO worker_app;
GRANT SELECT, INSERT, UPDATE ON agent_runs, approvals TO worker_app;
GRANT SELECT, INSERT, UPDATE ON spend TO worker_app;

-- Staff read pending approvals through the portal, inside their own tenant.
CREATE POLICY portal_approvals ON approvals FOR SELECT TO portal_app
  USING (app_tenant_matches(tenant_id) AND app_customer_matches(customer_id));
GRANT SELECT ON approvals TO portal_app;

-- migrate:down
DROP TABLE spend;
DROP TABLE approvals;
DROP TABLE agent_runs;
DROP POLICY worker_tickets ON tickets;
DROP POLICY worker_tenants ON tenants;
ALTER TABLE tickets
  DROP COLUMN outcome, DROP COLUMN reason_code, DROP COLUMN reply, DROP COLUMN resolved_at;
