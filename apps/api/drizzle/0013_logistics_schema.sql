CREATE SCHEMA IF NOT EXISTS logistics;

CREATE TABLE logistics.carriers (
  user_id uuid PRIMARY KEY,
  vehicle_type text NOT NULL,
  capacity_kg integer NOT NULL,
  plate text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  CONSTRAINT carriers_capacity_positive_check CHECK (capacity_kg > 0),
  CONSTRAINT carriers_vehicle_type_length_check CHECK (char_length(vehicle_type) BETWEEN 2 AND 40),
  CONSTRAINT carriers_plate_format_check CHECK (plate ~ '^[A-Z0-9-]{3,12}$')
);

CREATE UNIQUE INDEX carriers_plate_active_idx ON logistics.carriers (plate) WHERE deleted_at IS NULL;

CREATE TABLE logistics.trips (
  id uuid PRIMARY KEY,
  carrier_id uuid NOT NULL,
  status text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  planned_at timestamptz NOT NULL,
  route jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  CONSTRAINT trips_status_check CHECK (status IN ('planned', 'assigned', 'in_progress', 'completed', 'cancelled')),
  CONSTRAINT trips_version_positive_check CHECK (version > 0)
);

CREATE INDEX trips_carrier_status_idx ON logistics.trips (carrier_id, status);
CREATE INDEX trips_planned_at_idx ON logistics.trips (planned_at);

CREATE TABLE logistics.trip_stops (
  id uuid PRIMARY KEY,
  trip_id uuid NOT NULL REFERENCES logistics.trips(id) ON DELETE CASCADE,
  order_id uuid NOT NULL,
  order_version integer NOT NULL,
  kind text NOT NULL,
  sequence integer NOT NULL,
  zone text NOT NULL,
  scheduled_at timestamptz,
  completed_at timestamptz,
  CONSTRAINT trip_stops_kind_check CHECK (kind IN ('pickup', 'delivery')),
  CONSTRAINT trip_stops_sequence_positive_check CHECK (sequence > 0),
  CONSTRAINT trip_stops_order_version_check CHECK (order_version > 0),
  CONSTRAINT trip_stops_zone_check CHECK (char_length(zone) BETWEEN 1 AND 200),
  CONSTRAINT trip_stops_trip_sequence_key UNIQUE (trip_id, sequence),
  CONSTRAINT trip_stops_trip_order_kind_key UNIQUE (trip_id, order_id, kind)
);

CREATE INDEX trip_stops_trip_idx ON logistics.trip_stops (trip_id);
CREATE INDEX trip_stops_order_kind_idx ON logistics.trip_stops (order_id, kind);

CREATE TABLE logistics.checkins (
  id uuid PRIMARY KEY,
  stop_id uuid NOT NULL REFERENCES logistics.trip_stops(id) ON DELETE CASCADE,
  trip_id uuid NOT NULL REFERENCES logistics.trips(id) ON DELETE CASCADE,
  order_id uuid NOT NULL,
  carrier_id uuid NOT NULL,
  kind text NOT NULL,
  client_ts timestamptz NOT NULL,
  media_ref text,
  created_at timestamptz NOT NULL,
  CONSTRAINT checkins_kind_check CHECK (kind IN ('pickup', 'delivery')),
  CONSTRAINT checkins_stop_kind_key UNIQUE (stop_id, kind)
);

CREATE INDEX checkins_trip_idx ON logistics.checkins (trip_id, created_at);
CREATE INDEX checkins_order_idx ON logistics.checkins (order_id);

CREATE TABLE logistics.incidents (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL,
  trip_id uuid REFERENCES logistics.trips(id) ON DELETE SET NULL,
  type text NOT NULL,
  description text NOT NULL,
  status text NOT NULL,
  opened_at timestamptz NOT NULL,
  closed_at timestamptz,
  deleted_at timestamptz,
  CONSTRAINT incidents_status_check CHECK (status IN ('open', 'resolved')),
  CONSTRAINT incidents_type_length_check CHECK (char_length(type) BETWEEN 1 AND 60),
  CONSTRAINT incidents_description_length_check CHECK (char_length(description) BETWEEN 1 AND 1000)
);

CREATE INDEX incidents_trip_idx ON logistics.incidents (trip_id);
CREATE INDEX incidents_order_idx ON logistics.incidents (order_id);
