-- Liveness of worker processes: each one upserts its row every minute (job
-- shared.worker-heartbeat); GET /ready fails when the newest beat is too old.
CREATE TABLE shared.worker_heartbeats (
  worker_id text PRIMARY KEY,
  beat_at timestamptz NOT NULL,
  CONSTRAINT worker_heartbeats_id_check CHECK (char_length(worker_id) BETWEEN 1 AND 200)
);
