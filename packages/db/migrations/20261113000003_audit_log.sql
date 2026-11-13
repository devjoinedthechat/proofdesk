-- migrate:up
-- An append-only log in which every entry carries the hash of the one before
-- it. Changing or removing an entry breaks every hash after it.
CREATE TABLE audit_log (
  seq bigint PRIMARY KEY,
  tenant_id text NOT NULL,
  ticket_id text,
  at timestamptz NOT NULL,
  actor text NOT NULL,
  event text NOT NULL,
  -- JSON as text, hashed exactly as stored. Identifiers and amounts only:
  -- no ticket text and no personal data, so a deletion request never has to
  -- touch this table.
  detail text NOT NULL,
  prev_hash text NOT NULL,
  hash text NOT NULL
);

CREATE FUNCTION audit_entry_hash(
  prev_hash text, seq bigint, tenant_id text, ticket_id text,
  at timestamptz, actor text, event text, detail text
) RETURNS text
  LANGUAGE sql STABLE
  RETURN encode(
    sha256(convert_to(
      concat_ws(
        E'\x1f',
        prev_hash, seq::text, tenant_id, coalesce(ticket_id, ''),
        to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        actor, event, detail
      ),
      'UTF8'
    )),
    'hex'
  );

-- The only way to write to the log. It runs with the owner's rights, so the
-- calling role needs no privilege on the table itself and cannot update or
-- delete entries. The lock makes appends take turns, so the chain cannot fork.
CREATE FUNCTION audit_append(
  p_tenant_id text, p_ticket_id text, p_at timestamptz,
  p_actor text, p_event text, p_detail text
) RETURNS bigint
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  last_seq bigint;
  last_hash text;
  new_seq bigint;
  new_prev text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('proofdesk.audit_log'));
  SELECT seq, hash INTO last_seq, last_hash FROM audit_log ORDER BY seq DESC LIMIT 1;
  new_seq := coalesce(last_seq, 0) + 1;
  new_prev := coalesce(last_hash, repeat('0', 64));
  INSERT INTO audit_log (seq, tenant_id, ticket_id, at, actor, event, detail, prev_hash, hash)
  VALUES (
    new_seq, p_tenant_id, p_ticket_id, p_at, p_actor, p_event, p_detail, new_prev,
    audit_entry_hash(new_prev, new_seq, p_tenant_id, p_ticket_id, p_at, p_actor, p_event, p_detail)
  );
  RETURN new_seq;
END;
$$;

-- Walks the chain and reports every entry that does not follow from the one
-- before it. An intact log returns no rows.
CREATE FUNCTION audit_verify() RETURNS TABLE (seq bigint, problem text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  entry audit_log%ROWTYPE;
  expected_seq bigint := 1;
  expected_prev text := repeat('0', 64);
BEGIN
  FOR entry IN SELECT * FROM audit_log ORDER BY audit_log.seq LOOP
    IF entry.seq <> expected_seq THEN
      seq := entry.seq; problem := 'missing entries before this one'; RETURN NEXT;
    END IF;
    IF entry.prev_hash <> expected_prev THEN
      seq := entry.seq; problem := 'does not link to the previous entry'; RETURN NEXT;
    END IF;
    IF entry.hash <> audit_entry_hash(
      entry.prev_hash, entry.seq, entry.tenant_id, entry.ticket_id,
      entry.at, entry.actor, entry.event, entry.detail
    ) THEN
      seq := entry.seq; problem := 'content does not match its hash'; RETURN NEXT;
    END IF;
    expected_seq := entry.seq + 1;
    expected_prev := entry.hash;
  END LOOP;
END;
$$;

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON FUNCTION audit_append, audit_verify, audit_entry_hash FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_append TO worker_app;

-- migrate:down
DROP FUNCTION audit_verify;
DROP FUNCTION audit_append;
DROP FUNCTION audit_entry_hash;
DROP TABLE audit_log;
