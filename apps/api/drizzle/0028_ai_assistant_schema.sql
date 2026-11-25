CREATE SCHEMA IF NOT EXISTS ai_assistant;

-- A producer's lot draft built from chat messages. One active draft per user. short_code is
-- what Telegram buttons carry (callback_data <= 64 bytes), never the UUID. Fields (product
-- words, prices, coordinates) are cleared when the draft finishes; finished drafts are purged.
CREATE SEQUENCE ai_assistant.lot_drafts_short_code_seq;
CREATE TABLE ai_assistant.lot_drafts (
  id uuid PRIMARY KEY,
  short_code bigint NOT NULL UNIQUE,
  user_id uuid NOT NULL,
  status text NOT NULL,
  version integer NOT NULL,
  fields jsonb NOT NULL,
  question text,
  lot_id uuid NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT lot_drafts_status_check CHECK (
    status IN ('collecting', 'awaiting_confirmation', 'confirmed', 'saved_as_draft', 'cancelled', 'expired')
  ),
  CONSTRAINT lot_drafts_version_check CHECK (version >= 1),
  CONSTRAINT lot_drafts_fields_check CHECK (
    jsonb_typeof(fields) = 'object' AND octet_length(fields::text) <= 16384
  ),
  CONSTRAINT lot_drafts_finished_fields_check CHECK (
    status IN ('collecting', 'awaiting_confirmation') OR (fields = '{}'::jsonb AND question IS NULL)
  ),
  CONSTRAINT lot_drafts_question_check CHECK (question IS NULL OR char_length(question) <= 32)
);
CREATE UNIQUE INDEX lot_drafts_one_active_per_user
  ON ai_assistant.lot_drafts (user_id) WHERE status IN ('collecting', 'awaiting_confirmation');
CREATE INDEX lot_drafts_active_expiry_idx
  ON ai_assistant.lot_drafts (expires_at) WHERE status IN ('collecting', 'awaiting_confirmation');
CREATE INDEX lot_drafts_finished_idx
  ON ai_assistant.lot_drafts (updated_at) WHERE status NOT IN ('collecting', 'awaiting_confirmation');

-- Chat messages waiting for the worker. Written in the webhook's transaction together with
-- messaging.processed_updates; the row (and the user's text in it) is deleted once handled.
CREATE TABLE ai_assistant.inbox (
  id uuid PRIMARY KEY,
  seq bigserial NOT NULL UNIQUE,
  channel text NOT NULL,
  channel_user_id text NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  lease_token uuid,
  lease_until timestamptz,
  available_at timestamptz NOT NULL,
  CONSTRAINT inbox_payload_check CHECK (
    jsonb_typeof(payload) = 'object' AND payload->>'type' IN ('text', 'action', 'location')
    AND octet_length(payload::text) <= 4096
  ),
  CONSTRAINT inbox_lease_check CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
  CONSTRAINT inbox_attempts_check CHECK (attempts >= 0)
);
CREATE INDEX inbox_chat_seq_idx ON ai_assistant.inbox (channel, channel_user_id, seq);

-- Model usage, without any content: tokens, latency and outcome per call.
CREATE TABLE ai_assistant.usage (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  day date NOT NULL,
  purpose text NOT NULL,
  input_tokens integer NOT NULL,
  output_tokens integer NOT NULL,
  latency_ms integer NOT NULL,
  outcome text NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT usage_purpose_check CHECK (purpose IN ('extract', 'choose_product')),
  CONSTRAINT usage_outcome_check CHECK (
    outcome IN ('ok', 'invalid_output', 'timeout', 'unavailable', 'rejected', 'refusal', 'truncated', 'budget_exhausted')
  ),
  CONSTRAINT usage_tokens_check CHECK (input_tokens >= 0 AND output_tokens >= 0 AND latency_ms >= 0)
);
CREATE INDEX usage_user_day_idx ON ai_assistant.usage (user_id, day);
CREATE INDEX usage_created_at_idx ON ai_assistant.usage (created_at);

-- Monthly token budget. A call first reserves its worst case with a conditional UPDATE
-- (used + reserved + new <= cap), then the reservation is replaced by the real consumption.
CREATE TABLE ai_assistant.monthly_budget (
  month date PRIMARY KEY,
  used_tokens bigint NOT NULL DEFAULT 0,
  reserved_tokens bigint NOT NULL DEFAULT 0,
  CONSTRAINT monthly_budget_tokens_check CHECK (used_tokens >= 0 AND reserved_tokens >= 0),
  CONSTRAINT monthly_budget_month_check CHECK (extract(day FROM month) = 1)
);
