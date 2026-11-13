-- migrate:up
-- A ticket's conversation after its first message: the agent's replies, the
-- customer's answers, and a member of staff's reply when one takes over.
-- The first message stays on the ticket itself.
CREATE TABLE ticket_messages (
  id text PRIMARY KEY,
  -- The order messages were written in. Two messages can share a timestamp.
  seq bigint GENERATED ALWAYS AS IDENTITY,
  ticket_id text NOT NULL REFERENCES tickets (id),
  tenant_id text NOT NULL REFERENCES tenants (id),
  customer_id text NOT NULL REFERENCES customers (id),
  author text NOT NULL CHECK (author IN ('customer', 'agent', 'staff')),
  body text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX ticket_messages_ticket_idx ON ticket_messages (ticket_id, seq);

ALTER TABLE ticket_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY portal_ticket_messages ON ticket_messages TO portal_app
  USING (app_tenant_matches(tenant_id) AND app_customer_matches(customer_id))
  WITH CHECK (app_tenant_matches(tenant_id) AND app_customer_matches(customer_id));
CREATE POLICY worker_ticket_messages ON ticket_messages TO worker_app
  USING (app_tenant_matches(tenant_id) AND app_customer_matches(customer_id))
  WITH CHECK (app_tenant_matches(tenant_id) AND app_customer_matches(customer_id));
GRANT SELECT, INSERT ON ticket_messages TO portal_app, worker_app;

-- The portal may reopen a ticket when its customer answers, and close one
-- with a member of staff's reply. It still cannot set an outcome.
GRANT UPDATE (status, reply) ON tickets TO portal_app;

-- Work the portal has promised and not yet handed to the workflow engine.
-- A row is written in the same transaction as the ticket, the reply or the
-- deletion request it belongs to, so the promise cannot be lost: if the
-- portal stops before the workflow starts, a sweeper starts it later.
CREATE TABLE workflow_outbox (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('ticket', 'follow_up', 'deletion')),
  tenant_id text NOT NULL REFERENCES tenants (id),
  customer_id text NOT NULL,
  ticket_id text NOT NULL,
  -- What the workflow is started with: identifiers only.
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  started_at timestamptz
);
CREATE INDEX workflow_outbox_pending_idx ON workflow_outbox (created_at) WHERE started_at IS NULL;

ALTER TABLE workflow_outbox ENABLE ROW LEVEL SECURITY;
CREATE POLICY portal_workflow_outbox ON workflow_outbox TO portal_app
  USING (app_tenant_matches(tenant_id) AND app_customer_matches(customer_id))
  WITH CHECK (app_tenant_matches(tenant_id) AND app_customer_matches(customer_id));
GRANT SELECT, INSERT ON workflow_outbox TO portal_app;
GRANT UPDATE (started_at) ON workflow_outbox TO portal_app;

-- The sweeper works across tenants, so it gets two narrow functions and no
-- access to the table: read what is overdue, and mark one row started.
CREATE FUNCTION pending_outbox(p_before timestamptz, p_limit integer)
  RETURNS SETOF workflow_outbox
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT * FROM workflow_outbox
  WHERE started_at IS NULL AND created_at < p_before
  ORDER BY created_at
  LIMIT p_limit
$$;

CREATE FUNCTION mark_outbox_started(p_id text, p_at timestamptz) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  changed integer;
BEGIN
  UPDATE workflow_outbox SET started_at = p_at WHERE id = p_id AND started_at IS NULL;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed > 0;
END;
$$;

REVOKE ALL ON FUNCTION pending_outbox, mark_outbox_started FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pending_outbox, mark_outbox_started TO worker_app;

-- A deletion now also removes the customer's messages and their pending work.
CREATE OR REPLACE FUNCTION erase_customer(p_request_id text, p_at timestamptz) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  request deletion_requests%ROWTYPE;
  n_assertions integer;
  n_grants integer;
  n_memories integer;
  n_approvals integer;
  n_runs integer;
  n_messages integer;
  n_tickets integer;
  n_customers integer;
  result jsonb;
BEGIN
  SELECT * INTO request FROM deletion_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No deletion request %', p_request_id USING ERRCODE = 'no_data_found';
  END IF;
  IF request.status = 'completed' THEN
    RETURN request.erased;
  END IF;

  DELETE FROM grant_assertions WHERE ticket_id IN (
    SELECT ticket_id FROM ticket_grants
    WHERE tenant_id = request.tenant_id AND customer_id = request.customer_id
  );
  GET DIAGNOSTICS n_assertions = ROW_COUNT;
  DELETE FROM ticket_grants
    WHERE tenant_id = request.tenant_id AND customer_id = request.customer_id;
  GET DIAGNOSTICS n_grants = ROW_COUNT;
  DELETE FROM memories
    WHERE tenant_id = request.tenant_id AND customer_id = request.customer_id;
  GET DIAGNOSTICS n_memories = ROW_COUNT;
  DELETE FROM approvals
    WHERE tenant_id = request.tenant_id AND customer_id = request.customer_id;
  GET DIAGNOSTICS n_approvals = ROW_COUNT;
  DELETE FROM agent_runs
    WHERE tenant_id = request.tenant_id AND customer_id = request.customer_id;
  GET DIAGNOSTICS n_runs = ROW_COUNT;
  DELETE FROM ticket_messages
    WHERE tenant_id = request.tenant_id AND customer_id = request.customer_id;
  GET DIAGNOSTICS n_messages = ROW_COUNT;
  DELETE FROM workflow_outbox
    WHERE tenant_id = request.tenant_id AND customer_id = request.customer_id;
  DELETE FROM tickets
    WHERE tenant_id = request.tenant_id AND customer_id = request.customer_id;
  GET DIAGNOSTICS n_tickets = ROW_COUNT;
  DELETE FROM customers
    WHERE tenant_id = request.tenant_id AND id = request.customer_id;
  GET DIAGNOSTICS n_customers = ROW_COUNT;

  result := jsonb_build_object(
    'customers', n_customers, 'tickets', n_tickets, 'agentRuns', n_runs,
    'approvals', n_approvals, 'memories', n_memories, 'messages', n_messages,
    'grants', n_grants, 'grantAssertions', n_assertions
  );
  UPDATE deletion_requests
    SET status = 'completed', completed_at = p_at, erased = result
    WHERE id = p_request_id;
  RETURN result;
END;
$$;

-- migrate:down
DROP FUNCTION mark_outbox_started;
DROP FUNCTION pending_outbox;
DROP TABLE workflow_outbox;
REVOKE UPDATE (status, reply) ON tickets FROM portal_app;
DROP TABLE ticket_messages;
