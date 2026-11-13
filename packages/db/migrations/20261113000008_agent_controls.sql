-- migrate:up
-- The kill switch. A row pauses the whole agent for a tenant (scope 'agent')
-- or one of its tools (scope 'tool:<name>'). No row means not paused.
CREATE TABLE agent_controls (
  tenant_id text NOT NULL REFERENCES tenants (id),
  scope text NOT NULL CHECK (scope = 'agent' OR scope LIKE 'tool:%'),
  paused boolean NOT NULL,
  reason text NOT NULL,
  -- A member of staff, or the system component that acted.
  set_by text NOT NULL,
  set_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, scope)
);

ALTER TABLE agent_controls ENABLE ROW LEVEL SECURITY;

-- Staff, through the portal, can pause and resume inside their own tenant.
CREATE POLICY portal_agent_controls ON agent_controls TO portal_app
  USING (app_tenant_matches(tenant_id)) WITH CHECK (app_tenant_matches(tenant_id));
GRANT SELECT, INSERT, UPDATE ON agent_controls TO portal_app;

-- The worker reads the switch before every model turn and tool call.
CREATE POLICY worker_agent_controls ON agent_controls FOR SELECT TO worker_app
  USING (app_tenant_matches(tenant_id));
GRANT SELECT ON agent_controls TO worker_app;

-- Automation may stop the agent and may never restart it. The worker gets
-- this function and no write access to the table, so a pause set by a
-- watchdog stays until a person lifts it.
CREATE FUNCTION pause_agent(
  p_tenant_id text, p_scope text, p_reason text, p_set_by text, p_at timestamptz
) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  changed integer;
BEGIN
  INSERT INTO agent_controls (tenant_id, scope, paused, reason, set_by, set_at)
  VALUES (p_tenant_id, p_scope, true, p_reason, p_set_by, p_at)
  ON CONFLICT (tenant_id, scope) DO UPDATE
    SET paused = true, reason = excluded.reason, set_by = excluded.set_by, set_at = excluded.set_at
    WHERE NOT agent_controls.paused;
  GET DIAGNOSTICS changed = ROW_COUNT;
  -- True only when this call is what paused it.
  RETURN changed > 0;
END;
$$;

REVOKE ALL ON FUNCTION pause_agent FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pause_agent TO worker_app;

-- Staff actions on the switch are written to the audit log by the portal.
GRANT EXECUTE ON FUNCTION audit_append TO portal_app;

-- migrate:down
REVOKE EXECUTE ON FUNCTION audit_append FROM portal_app;
DROP FUNCTION pause_agent;
DROP TABLE agent_controls;
