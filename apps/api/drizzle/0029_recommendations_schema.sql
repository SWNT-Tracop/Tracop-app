CREATE SCHEMA IF NOT EXISTS recommendations;

-- Reference prices from an imported file (DANE-SIPSA). One row per source observation;
-- importing the same file twice changes nothing.
CREATE TABLE recommendations.reference_imports (
  id uuid PRIMARY KEY,
  source text NOT NULL,
  file_sha256 text NOT NULL UNIQUE,
  rows_imported integer NOT NULL,
  imported_at timestamptz NOT NULL,
  CONSTRAINT reference_imports_source_check CHECK (source IN ('DANE-SIPSA')),
  CONSTRAINT reference_imports_hash_check CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT reference_imports_rows_check CHECK (rows_imported >= 0)
);

CREATE TABLE recommendations.reference_prices (
  id uuid PRIMARY KEY,
  source text NOT NULL,
  market text NOT NULL,
  source_product text NOT NULL,
  presentation text NOT NULL,
  price bigint NOT NULL,
  observed_on date NOT NULL,
  imported_at timestamptz NOT NULL,
  import_id uuid NOT NULL REFERENCES recommendations.reference_imports(id),
  CONSTRAINT reference_prices_source_check CHECK (source IN ('DANE-SIPSA')),
  CONSTRAINT reference_prices_price_check CHECK (price > 0),
  CONSTRAINT reference_prices_text_check CHECK (
    char_length(market) BETWEEN 1 AND 120 AND char_length(source_product) BETWEEN 1 AND 120
    AND char_length(presentation) BETWEEN 1 AND 120
  ),
  CONSTRAINT reference_prices_observation_unique UNIQUE (source, market, source_product, presentation, observed_on)
);
CREATE INDEX reference_prices_product_idx
  ON recommendations.reference_prices (source, source_product, presentation, observed_on);

-- Staff decide which source product and presentation is which catalog product and unit;
-- nothing is matched automatically and no unit equivalence is assumed.
CREATE TABLE recommendations.product_source_mappings (
  id uuid PRIMARY KEY,
  product_id uuid NOT NULL,
  unit text NOT NULL,
  source text NOT NULL,
  source_product text NOT NULL,
  presentation text NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT product_source_mappings_source_check CHECK (source IN ('DANE-SIPSA')),
  CONSTRAINT product_source_mappings_unique UNIQUE (source, source_product, presentation)
);
CREATE INDEX product_source_mappings_product_idx ON recommendations.product_source_mappings (product_id, unit);

-- TRACOP's own prices: product, unit, price and date only. provider_key is a keyed hash
-- (HMAC) that only lets the module count distinct providers; no person ids are stored.
CREATE TABLE recommendations.price_observations (
  id uuid PRIMARY KEY,
  order_line_key text NOT NULL UNIQUE,
  product_id uuid NOT NULL,
  unit text NOT NULL,
  unit_price bigint NOT NULL,
  provider_key text NOT NULL,
  observed_at timestamptz NOT NULL,
  delivered_at timestamptz,
  CONSTRAINT price_observations_price_check CHECK (unit_price > 0),
  CONSTRAINT price_observations_keys_check CHECK (
    order_line_key ~ '^[0-9a-f]{64}$' AND provider_key ~ '^[0-9a-f]{64}$'
  )
);
CREATE INDEX price_observations_product_idx ON recommendations.price_observations (product_id, unit, observed_at);

-- Each buyer's own purchases, used only for that buyer's recommendations.
CREATE TABLE recommendations.buyer_history (
  buyer_id uuid NOT NULL,
  product_id uuid NOT NULL,
  orders_count integer NOT NULL,
  last_ordered_at timestamptz NOT NULL,
  PRIMARY KEY (buyer_id, product_id),
  CONSTRAINT buyer_history_count_check CHECK (orders_count >= 1)
);
CREATE TABLE recommendations.counted_orders (
  order_id uuid PRIMARY KEY,
  counted_at timestamptz NOT NULL
);

-- Buyer alerts. The centre is stored rounded to 2 decimals (~1.1 km), never the exact point.
CREATE TABLE recommendations.price_alerts (
  id uuid PRIMARY KEY,
  buyer_id uuid NOT NULL,
  product_id uuid NOT NULL,
  max_price bigint NOT NULL,
  radius_km integer NOT NULL,
  center_lat numeric(5,2) NOT NULL,
  center_lng numeric(5,2) NOT NULL,
  created_at timestamptz NOT NULL,
  deleted_at timestamptz,
  CONSTRAINT price_alerts_price_check CHECK (max_price > 0),
  CONSTRAINT price_alerts_radius_check CHECK (radius_km BETWEEN 1 AND 300),
  CONSTRAINT price_alerts_center_check CHECK (
    center_lat BETWEEN -4.30 AND 13.70 AND center_lng BETWEEN -81.80 AND -66.90
  )
);
CREATE INDEX price_alerts_product_idx ON recommendations.price_alerts (product_id) WHERE deleted_at IS NULL;
CREATE INDEX price_alerts_buyer_idx ON recommendations.price_alerts (buyer_id) WHERE deleted_at IS NULL;

-- One notice per (alert, lot), whatever the number of deliveries of LotPublished.
CREATE TABLE recommendations.alert_matches (
  alert_id uuid NOT NULL REFERENCES recommendations.price_alerts(id),
  lot_id uuid NOT NULL,
  matched_at timestamptz NOT NULL,
  PRIMARY KEY (alert_id, lot_id)
);
