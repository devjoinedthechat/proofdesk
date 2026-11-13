-- migrate:up
-- A member of staff's verdict on a ticket the agent handed over: whether the
-- agent was right to, and what the correct result would have been. This is
-- what turns a failure in production into a test.
--
-- The verdict is structured: fixed words, identifiers and amounts. There is
-- no free-text note, so reviewing adds no new personal data.
CREATE TABLE ticket_reviews (
  ticket_id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants (id),
  verdict text NOT NULL CHECK (verdict IN ('agent_right', 'agent_wrong')),
  expected_outcome text NOT NULL CHECK (
    expected_outcome IN ('refunded', 'plan_changed', 'refused', 'needs_clarification', 'handed_to_staff')
  ),
  expected_reason text NOT NULL,
  -- The refunds that should have been made: payment ids and amounts.
  expected_refunds jsonb NOT NULL DEFAULT '[]',
  reviewed_by text NOT NULL,
  reviewed_at timestamptz NOT NULL
);

ALTER TABLE ticket_reviews ENABLE ROW LEVEL SECURITY;
CREATE POLICY portal_ticket_reviews ON ticket_reviews TO portal_app
  USING (app_tenant_matches(tenant_id)) WITH CHECK (app_tenant_matches(tenant_id));
GRANT SELECT, INSERT ON ticket_reviews TO portal_app;

-- migrate:down
DROP TABLE ticket_reviews;
