-- migrate:up
CREATE TABLE plans (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  billing_interval text NOT NULL CHECK (billing_interval IN ('month', 'year')),
  price_cents integer NOT NULL CHECK (price_cents >= 0),
  currency char(3) NOT NULL,
  UNIQUE (tenant_id, code)
);

CREATE TABLE subscriptions (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  customer_id text NOT NULL,
  plan_id text NOT NULL REFERENCES plans (id),
  status text NOT NULL CHECK (status IN ('active', 'past_due', 'canceled')),
  seats integer NOT NULL CHECK (seats > 0),
  started_at timestamptz NOT NULL,
  current_period_start timestamptz NOT NULL,
  current_period_end timestamptz NOT NULL,
  canceled_at timestamptz
);

CREATE TABLE invoices (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  customer_id text NOT NULL,
  subscription_id text NOT NULL REFERENCES subscriptions (id),
  number text NOT NULL,
  status text NOT NULL CHECK (status IN ('open', 'paid', 'void')),
  amount_cents integer NOT NULL CHECK (amount_cents >= 0),
  currency char(3) NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  issued_at timestamptz NOT NULL,
  UNIQUE (tenant_id, number)
);

CREATE TABLE payments (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  customer_id text NOT NULL,
  invoice_id text NOT NULL REFERENCES invoices (id),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  status text NOT NULL CHECK (status IN ('succeeded', 'failed', 'disputed')),
  created_at timestamptz NOT NULL
);

CREATE TABLE refunds (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  payment_id text NOT NULL REFERENCES payments (id),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  reason text NOT NULL CHECK (reason IN ('duplicate_charge', 'customer_request', 'service_credit')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  -- A retried request with the same key returns the first refund instead of
  -- paying twice. The fingerprint detects a key reused for a different request.
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL,
  UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX subscriptions_customer_idx ON subscriptions (tenant_id, customer_id);
CREATE INDEX invoices_customer_idx ON invoices (tenant_id, customer_id);
CREATE INDEX payments_invoice_idx ON payments (invoice_id);
CREATE INDEX refunds_payment_idx ON refunds (payment_id);

-- migrate:down
DROP TABLE refunds;
DROP TABLE payments;
DROP TABLE invoices;
DROP TABLE subscriptions;
DROP TABLE plans;
