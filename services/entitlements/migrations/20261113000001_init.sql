-- migrate:up
CREATE TABLE entitlements (
  tenant_id text NOT NULL,
  customer_id text NOT NULL,
  plan_code text NOT NULL,
  seats integer NOT NULL CHECK (seats > 0),
  status text NOT NULL CHECK (status IN ('active', 'suspended')),
  -- Incremented on every write. A writer must name the version it read.
  version integer NOT NULL CHECK (version > 0),
  updated_at timestamptz NOT NULL,
  updated_by text NOT NULL,
  PRIMARY KEY (tenant_id, customer_id)
);

-- migrate:down
DROP TABLE entitlements;
