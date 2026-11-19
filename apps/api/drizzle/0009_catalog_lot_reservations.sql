CREATE TABLE catalog.lot_reservations (
  id uuid PRIMARY KEY,
  lot_id uuid NOT NULL,
  order_id uuid NOT NULL,
  quantity_milli numeric(12,3) NOT NULL,
  status text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT lot_reservations_quantity_positive_check CHECK (quantity_milli > 0),
  CONSTRAINT lot_reservations_status_check CHECK (status IN ('active', 'released', 'consumed')),
  CONSTRAINT lot_reservations_expiry_check CHECK (expires_at >= created_at)
);

CREATE INDEX lot_reservations_lot_status_expiry_idx
  ON catalog.lot_reservations (lot_id, status, expires_at);
CREATE INDEX lot_reservations_order_status_idx
  ON catalog.lot_reservations (order_id, status);
CREATE UNIQUE INDEX lot_reservations_active_order_lot_unique
  ON catalog.lot_reservations (lot_id, order_id) WHERE status = 'active';
