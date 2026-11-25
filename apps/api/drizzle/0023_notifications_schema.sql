CREATE SCHEMA IF NOT EXISTS notifications;

-- Per-user delivery preferences; absent rows mean the defaults (messaging, push, sms; no quiet
-- hours). Quiet hours are local times in America/Bogota.
CREATE TABLE notifications.preferences (
  user_id uuid PRIMARY KEY,
  channel_order jsonb NOT NULL,
  quiet_hours jsonb,
  updated_at timestamptz NOT NULL,
  CONSTRAINT preferences_channel_order_check CHECK (jsonb_typeof(channel_order) = 'array'),
  CONSTRAINT preferences_quiet_hours_check CHECK (
    quiet_hours IS NULL OR jsonb_typeof(quiet_hours) = 'object'
  )
);

-- What the user sees in the app; one row per (event, user), which makes the outbox consumer
-- idempotent.
CREATE TABLE notifications.inbox (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  event_id uuid NOT NULL,
  kind text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  template_version text NOT NULL,
  created_at timestamptz NOT NULL,
  read_at timestamptz,
  CONSTRAINT inbox_event_user_unique UNIQUE (event_id, user_id),
  CONSTRAINT inbox_text_length_check CHECK (char_length(title) <= 120 AND char_length(body) <= 500)
);
CREATE INDEX inbox_user_created_idx ON notifications.inbox (user_id, created_at DESC, id DESC);

-- One attempt plan per (event, user, channel). Pending rows are claimed by the worker with a
-- lease; last_error holds a code, never the message text or a recipient.
CREATE TABLE notifications.deliveries (
  id uuid PRIMARY KEY,
  inbox_id uuid NOT NULL REFERENCES notifications.inbox(id),
  user_id uuid NOT NULL,
  event_id uuid NOT NULL,
  kind text NOT NULL,
  channel text NOT NULL,
  status text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  locked_until timestamptz,
  lease_token uuid,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT deliveries_event_user_channel_unique UNIQUE (event_id, user_id, channel),
  CONSTRAINT deliveries_channel_check CHECK (channel IN ('messaging', 'push', 'sms')),
  CONSTRAINT deliveries_status_check CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  CONSTRAINT deliveries_attempts_check CHECK (attempts >= 0),
  CONSTRAINT deliveries_pending_check CHECK (status <> 'pending' OR next_attempt_at IS NOT NULL),
  CONSTRAINT deliveries_lease_check CHECK ((locked_until IS NULL) = (lease_token IS NULL)),
  CONSTRAINT deliveries_error_length_check CHECK (char_length(coalesce(last_error, '')) <= 64)
);
CREATE INDEX deliveries_due_idx ON notifications.deliveries (next_attempt_at)
  WHERE status = 'pending';
CREATE INDEX deliveries_user_idx ON notifications.deliveries (user_id, created_at);
