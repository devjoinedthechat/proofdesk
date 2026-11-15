-- migrate:up

-- What model calls under way have set aside, one row per budget. A row
-- counts against its budget until the call settles and removes it, or until
-- it expires: a worker that dies in the middle of a call would otherwise
-- hold its estimate against the budget for good.
CREATE TABLE spend_reservations (
  id uuid NOT NULL,
  key text NOT NULL,
  micros bigint NOT NULL CHECK (micros >= 0),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (id, key)
);
CREATE INDEX spend_reservations_key ON spend_reservations (key);
CREATE INDEX spend_reservations_expires_at ON spend_reservations (expires_at);

-- UPDATE is what lets the sweep of expired rows lock them before it deletes.
GRANT SELECT, INSERT, UPDATE, DELETE ON spend_reservations TO worker_app;

-- migrate:down
DROP TABLE spend_reservations;
