-- migrate:up
-- A customer's request to have their data deleted, and the record that it
-- was done. The record holds identifiers and counts only, so it can outlive
-- the data it describes.
CREATE TABLE deletion_requests (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants (id),
  -- Not a foreign key: the customer row is deleted and this row stays.
  customer_id text NOT NULL,
  -- The ticket whose grant carries the authority to erase in other systems.
  ticket_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('requested', 'completed')),
  requested_at timestamptz NOT NULL,
  completed_at timestamptz,
  -- How many rows were removed from each table. No content.
  erased jsonb
);

-- One open request per customer.
CREATE UNIQUE INDEX deletion_requests_open_idx
  ON deletion_requests (tenant_id, customer_id) WHERE status = 'requested';

ALTER TABLE deletion_requests ENABLE ROW LEVEL SECURITY;

-- Only the portal creates a request, and only for the signed-in customer.
CREATE POLICY portal_deletion_requests ON deletion_requests TO portal_app
  USING (app_tenant_matches(tenant_id) AND app_customer_matches(customer_id))
  WITH CHECK (app_tenant_matches(tenant_id) AND app_customer_matches(customer_id));
GRANT SELECT, INSERT ON deletion_requests TO portal_app;

-- The worker can read a request. It cannot create one or mark one done.
CREATE POLICY worker_deletion_requests ON deletion_requests FOR SELECT TO worker_app
  USING (app_tenant_matches(tenant_id) AND app_customer_matches(customer_id));
GRANT SELECT ON deletion_requests TO worker_app;

-- Erases everything this database holds about one customer, in one
-- transaction, and marks the request completed.
--
-- This function is the only way the worker can delete a customer, and it acts
-- only on a request the portal recorded for that same customer. A worker that
-- is compromised, or simply wrong, cannot erase someone who did not ask.
--
-- Kept on purpose: the audit log (identifiers and amounts, no personal data),
-- the record of refunds the agent made, and model spend. Billing keeps its
-- payment records in its own database.
CREATE FUNCTION erase_customer(p_request_id text, p_at timestamptz) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  request deletion_requests%ROWTYPE;
  n_assertions integer;
  n_grants integer;
  n_memories integer;
  n_approvals integer;
  n_runs integer;
  n_tickets integer;
  n_customers integer;
  result jsonb;
BEGIN
  SELECT * INTO request FROM deletion_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No deletion request %', p_request_id USING ERRCODE = 'no_data_found';
  END IF;
  -- Done already: report what was done then, and change nothing.
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
  DELETE FROM tickets
    WHERE tenant_id = request.tenant_id AND customer_id = request.customer_id;
  GET DIAGNOSTICS n_tickets = ROW_COUNT;
  DELETE FROM customers
    WHERE tenant_id = request.tenant_id AND id = request.customer_id;
  GET DIAGNOSTICS n_customers = ROW_COUNT;

  result := jsonb_build_object(
    'customers', n_customers, 'tickets', n_tickets, 'agentRuns', n_runs,
    'approvals', n_approvals, 'memories', n_memories,
    'grants', n_grants, 'grantAssertions', n_assertions
  );
  UPDATE deletion_requests
    SET status = 'completed', completed_at = p_at, erased = result
    WHERE id = p_request_id;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION erase_customer FROM PUBLIC;
GRANT EXECUTE ON FUNCTION erase_customer TO worker_app;

-- migrate:down
DROP FUNCTION erase_customer;
DROP TABLE deletion_requests;
