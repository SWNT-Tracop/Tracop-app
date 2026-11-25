-- Outbox dispatch: retries with backoff, a dead-letter mark after the last attempt, a lease so
-- concurrent dispatchers never claim the same event, and one delivery row per consumer.
-- next_attempt_at NULL means "due now"; the dispatcher compares it with its own clock.

ALTER TABLE shared.outbox_events
  ADD COLUMN attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN next_attempt_at timestamptz,
  ADD COLUMN last_error text,
  ADD COLUMN failed_at timestamptz,
  ADD COLUMN locked_until timestamptz,
  ADD COLUMN lease_token uuid,
  ADD CONSTRAINT outbox_events_attempts_check CHECK (attempts >= 0),
  ADD CONSTRAINT outbox_events_last_error_check CHECK (char_length(last_error) <= 500),
  ADD CONSTRAINT outbox_events_lease_check
    CHECK ((locked_until IS NULL) = (lease_token IS NULL));

CREATE INDEX outbox_events_dispatch_idx
  ON shared.outbox_events (created_at, id)
  WHERE published_at IS NULL AND failed_at IS NULL;

CREATE TABLE shared.outbox_deliveries (
  consumer text NOT NULL,
  event_id uuid NOT NULL REFERENCES shared.outbox_events(id) ON DELETE CASCADE,
  delivered_at timestamptz NOT NULL,
  PRIMARY KEY (consumer, event_id),
  CONSTRAINT outbox_deliveries_consumer_check CHECK (char_length(consumer) BETWEEN 1 AND 100)
);

CREATE INDEX outbox_deliveries_event_idx ON shared.outbox_deliveries (event_id);
