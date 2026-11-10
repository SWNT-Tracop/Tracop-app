CREATE SCHEMA IF NOT EXISTS ordering;

CREATE TABLE ordering.orders (
  id uuid PRIMARY KEY,
  buyer_id uuid NOT NULL,
  provider_id uuid NOT NULL,
  status text NOT NULL,
  delivery_address text NOT NULL,
  delivery_window timestamptz,
  request_hash text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1,
  accepted_at timestamptz,
  cancel_reason text,
  deleted_at timestamptz,
  CONSTRAINT orders_status_check CHECK (status IN ('draft', 'requested', 'quoted', 'accepted', 'payment_pending', 'paid', 'pickup_scheduled', 'in_transit', 'delivered', 'closed', 'disputed', 'cancelled'))
);

CREATE INDEX orders_buyer_created_idx ON ordering.orders (buyer_id, created_at);
CREATE INDEX orders_provider_accepted_idx ON ordering.orders (provider_id, accepted_at);

CREATE TABLE ordering.order_lines (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES ordering.orders(id) ON DELETE CASCADE,
  lot_id uuid NOT NULL,
  provider_id uuid NOT NULL,
  quantity_milli numeric(12,3) NOT NULL,
  unit_price numeric(20,0) NOT NULL,
  unit text NOT NULL,
  CONSTRAINT order_lines_quantity_positive_check CHECK (quantity_milli > 0),
  CONSTRAINT order_lines_unit_price_nonnegative_check CHECK (unit_price >= 0)
);

CREATE INDEX order_lines_order_idx ON ordering.order_lines (order_id);
CREATE INDEX order_lines_lot_idx ON ordering.order_lines (lot_id);
CREATE INDEX order_lines_provider_idx ON ordering.order_lines (provider_id);

CREATE TABLE ordering.quotes (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES ordering.orders(id) ON DELETE CASCADE,
  subtotal numeric(20,0) NOT NULL,
  freight numeric(20,0) NOT NULL,
  commission numeric(20,0) NOT NULL,
  total numeric(20,0) NOT NULL,
  provider_net numeric(20,0) NOT NULL,
  valid_until timestamptz NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT quotes_status_check CHECK (status IN ('active', 'accepted', 'expired', 'cancelled')),
  CONSTRAINT quotes_amounts_nonnegative_check CHECK (subtotal >= 0 AND freight >= 0 AND commission >= 0 AND total >= 0 AND provider_net >= 0)
);

CREATE INDEX quotes_order_idx ON ordering.quotes (order_id);
CREATE INDEX quotes_validity_idx ON ordering.quotes (valid_until, status);

CREATE TABLE ordering.order_events (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES ordering.orders(id) ON DELETE CASCADE,
  type text NOT NULL,
  payload text NOT NULL,
  actor_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  prev_hash text,
  hash text NOT NULL,
  CONSTRAINT order_events_type_check CHECK (type IN ('OrderRequested', 'OrderQuoted', 'OrderAccepted', 'OrderCancelled'))
);

CREATE INDEX order_events_order_idx ON ordering.order_events (order_id, occurred_at);