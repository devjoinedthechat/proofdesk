-- migrate:up
CREATE TABLE tenants (
  id text PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  currency char(3) NOT NULL,
  -- Refund policy parameters. The policy layer reads these; billing does not.
  refund_window_days integer NOT NULL CHECK (refund_window_days >= 0),
  refund_approval_limit_cents integer NOT NULL CHECK (refund_approval_limit_cents >= 0)
);

CREATE TABLE customers (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants (id),
  email text NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (tenant_id, email)
);

CREATE TABLE tickets (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants (id),
  customer_id text NOT NULL REFERENCES customers (id),
  subject text NOT NULL,
  body text NOT NULL,
  status text NOT NULL CHECK (
    status IN ('open', 'waiting_approval', 'waiting_customer', 'handed_to_staff', 'resolved', 'refused')
  ),
  created_at timestamptz NOT NULL
);

CREATE INDEX customers_tenant_idx ON customers (tenant_id);
CREATE INDEX tickets_tenant_customer_idx ON tickets (tenant_id, customer_id);

-- migrate:down
DROP TABLE tickets;
DROP TABLE customers;
DROP TABLE tenants;
