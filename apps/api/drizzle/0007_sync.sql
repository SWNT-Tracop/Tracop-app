CREATE SCHEMA IF NOT EXISTS sync;

CREATE SEQUENCE sync.change_log_server_seq_seq AS bigint;

CREATE TABLE sync.processed_operations (
  op_id uuid PRIMARY KEY,
  device_id uuid NOT NULL,
  user_id uuid NOT NULL,
  entity text NOT NULL,
  entity_id uuid NOT NULL,
  result jsonb NOT NULL,
  error_code text,
  payload_hash text NOT NULL,
  server_seq bigint,
  processed_at timestamptz NOT NULL
);

CREATE TABLE sync.change_log (
  server_seq bigint PRIMARY KEY DEFAULT nextval('sync.change_log_server_seq_seq'),
  entity text NOT NULL,
  entity_id uuid NOT NULL,
  op text NOT NULL,
  payload jsonb NOT NULL,
  owner_user_id uuid,
  occurred_at timestamptz NOT NULL
);

CREATE INDEX change_log_owner_server_seq_idx
  ON sync.change_log (owner_user_id, server_seq);
