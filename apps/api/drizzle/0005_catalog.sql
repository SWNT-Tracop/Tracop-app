CREATE TABLE catalog.categories (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  parent_id uuid REFERENCES catalog.categories(id),
  depth integer NOT NULL CHECK (depth BETWEEN 1 AND 3),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  CONSTRAINT categories_not_self_parent CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE UNIQUE INDEX categories_parent_name_unique
  ON catalog.categories (COALESCE(parent_id::text, 'root'), lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX categories_parent_id_idx ON catalog.categories(parent_id);

CREATE TABLE catalog.products (
  id uuid PRIMARY KEY,
  category_id uuid NOT NULL REFERENCES catalog.categories(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  search_text text NOT NULL,
  unit text NOT NULL CHECK (unit IN ('kg','g','lb','und','docena','arroba','quintal','caja','mano','bulto')),
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(attributes) = 'object'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz
);
CREATE UNIQUE INDEX products_category_name_unique
  ON catalog.products(category_id, lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX products_category_idx ON catalog.products(category_id);

CREATE TABLE catalog.lots (
  id uuid PRIMARY KEY,
  provider_id uuid NOT NULL,
  product_id uuid NOT NULL REFERENCES catalog.products(id),
  quantity double precision NOT NULL CHECK (quantity > 0),
  unit text NOT NULL CHECK (unit IN ('kg','g','lb','und','docena','arroba','quintal','caja','mano','bulto')),
  unit_price bigint NOT NULL CHECK (unit_price > 0),
  quality_grade text CHECK (quality_grade IS NULL OR length(quality_grade) <= 100),
  available_from timestamptz NOT NULL,
  available_until timestamptz NOT NULL,
  location_lat double precision NOT NULL CHECK (location_lat BETWEEN -4.3 AND 13.7),
  location_lng double precision NOT NULL CHECK (location_lng BETWEEN -81.8 AND -66.9),
  status text NOT NULL CHECK (status IN ('draft','published','reserved','sold_out','expired','cancelled')),
  version integer NOT NULL CHECK (version > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  CONSTRAINT lots_window_check CHECK (available_from <= available_until)
);
CREATE INDEX lots_provider_status_idx ON catalog.lots(provider_id, status) WHERE deleted_at IS NULL;
CREATE INDEX lots_product_status_idx ON catalog.lots(product_id, status) WHERE deleted_at IS NULL;
CREATE INDEX lots_available_idx ON catalog.lots(status, available_until, available_from) WHERE deleted_at IS NULL;
CREATE INDEX lots_location_bbox_idx ON catalog.lots(location_lat, location_lng) WHERE deleted_at IS NULL;

CREATE TABLE catalog.lot_photos (
  id uuid PRIMARY KEY,
  lot_id uuid NOT NULL REFERENCES catalog.lots(id),
  media_ref text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX lot_photos_lot_id_idx ON catalog.lot_photos(lot_id);
