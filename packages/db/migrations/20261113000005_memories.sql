-- migrate:up
-- What the agent carries from one ticket of a customer to the next.
-- Every memory has an owner (the customer), a source (the ticket it was
-- derived from) and an expiry. Its content is structured facts computed by
-- the system from what happened, never text the customer or the model wrote.
CREATE TABLE memories (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants (id),
  customer_id text NOT NULL REFERENCES customers (id),
  kind text NOT NULL CHECK (kind IN ('ticket_summary')),
  source_ticket_id text NOT NULL REFERENCES tickets (id),
  content jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  -- One summary per ticket: writing it again replaces it.
  UNIQUE (source_ticket_id, kind)
);

CREATE INDEX memories_customer_idx ON memories (tenant_id, customer_id, created_at DESC);

ALTER TABLE memories ENABLE ROW LEVEL SECURITY;

CREATE POLICY worker_memories ON memories TO worker_app
  USING (app_tenant_matches(tenant_id) AND app_customer_matches(customer_id))
  WITH CHECK (app_tenant_matches(tenant_id) AND app_customer_matches(customer_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON memories TO worker_app;

-- migrate:down
DROP TABLE memories;
