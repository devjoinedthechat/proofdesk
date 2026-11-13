-- migrate:up
-- Which build handled a ticket: the stable one, or the canary.
ALTER TABLE tickets
  ADD COLUMN route text NOT NULL DEFAULT 'stable' CHECK (route IN ('stable', 'canary'));

-- How new tickets are divided between the stable build and a canary. One
-- row. The deploy pipeline sets it; nothing in the running system can raise
-- the canary's share.
CREATE TABLE rollout (
  id text PRIMARY KEY CHECK (id = 'agent'),
  -- Percent of new tickets sent to the canary, 0 to 100.
  canary_share integer NOT NULL CHECK (canary_share BETWEEN 0 AND 100),
  canary_version text,
  reason text NOT NULL,
  set_by text NOT NULL,
  set_at timestamptz NOT NULL
);
INSERT INTO rollout VALUES ('agent', 0, NULL, 'No canary', 'system:migration', now());
GRANT SELECT ON rollout TO portal_app, worker_app;

-- Something the watchdog did, or wants a person to look at.
CREATE TABLE alerts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL,
  -- Null for an alert about the whole system.
  tenant_id text,
  -- Counts and thresholds. No ticket content.
  detail jsonb NOT NULL,
  raised_by text NOT NULL,
  raised_at timestamptz NOT NULL
);
ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;

-- How the agent is doing, per tenant and route, since a moment. The watchdog
-- needs totals across tenants, and gets exactly that: counts, through this
-- function, with no access to any ticket.
--   failed: the run ended without a clean resolution, or the reply guard
--           stopped it. A ticket stopped by a pause is left out.
--   guard:  the reply guard stopped it, meaning the model misreported what
--           it had done.
CREATE FUNCTION agent_health(p_since timestamptz)
  RETURNS TABLE (tenant_id text, route text, finished integer, failed integer, guard integer)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT t.tenant_id, t.route,
         count(*)::integer,
         count(*) FILTER (
           WHERE t.reason_code LIKE 'agent\_%' OR t.reason_code LIKE 'guard\_%'
         )::integer,
         count(*) FILTER (WHERE t.reason_code LIKE 'guard\_%')::integer
  FROM tickets t
  WHERE t.resolved_at > p_since
    AND t.outcome IS NOT NULL
    AND t.category <> 'data_deletion'
    AND t.reason_code IS DISTINCT FROM 'agent_paused'
  GROUP BY t.tenant_id, t.route
$$;

-- Sends every new ticket back to the stable build. The watchdog may do this
-- and nothing else to the rollout: it cannot start or widen a canary.
CREATE FUNCTION rollback_canary(p_reason text, p_by text, p_at timestamptz) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  changed integer;
BEGIN
  UPDATE rollout SET canary_share = 0, reason = p_reason, set_by = p_by, set_at = p_at
    WHERE id = 'agent' AND canary_share > 0;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed > 0;
END;
$$;

CREATE FUNCTION raise_alert(
  p_kind text, p_tenant_id text, p_detail jsonb, p_by text, p_at timestamptz
) RETURNS bigint
  LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  INSERT INTO alerts (kind, tenant_id, detail, raised_by, raised_at)
  VALUES (p_kind, p_tenant_id, p_detail, p_by, p_at)
  RETURNING id
$$;

REVOKE ALL ON FUNCTION agent_health, rollback_canary, raise_alert FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agent_health, rollback_canary, raise_alert TO worker_app;

-- migrate:down
DROP FUNCTION raise_alert;
DROP FUNCTION rollback_canary;
DROP FUNCTION agent_health;
DROP TABLE alerts;
DROP TABLE rollout;
ALTER TABLE tickets DROP COLUMN route;
