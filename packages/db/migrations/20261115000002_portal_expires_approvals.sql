-- migrate:up

-- The portal may close a request for approval that nothing waits for any
-- more, and may do nothing else to one: only a pending request, only inside
-- the member of staff's own tenant, and only to "expired". Approving and
-- rejecting stay with the worker.
CREATE POLICY portal_expires_approvals ON approvals FOR UPDATE TO portal_app
  USING (
    app_tenant_matches(tenant_id) AND app_customer_matches(customer_id) AND status = 'pending'
  )
  WITH CHECK (status = 'expired');
GRANT UPDATE (status, decided_at, decided_by) ON approvals TO portal_app;

-- migrate:down
REVOKE UPDATE (status, decided_at, decided_by) ON approvals FROM portal_app;
DROP POLICY portal_expires_approvals ON approvals;
