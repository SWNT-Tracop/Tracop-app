CREATE SCHEMA IF NOT EXISTS trust;

-- One rating per (order, ratee kind): the buyer rates the provider and, if there was one, the
-- carrier that delivered. The comment is untrusted text: never public, never logged; staff can
-- hide it (the score stays).
CREATE TABLE trust.ratings (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL,
  rater_id uuid NOT NULL,
  ratee_id uuid NOT NULL,
  ratee_kind text NOT NULL,
  score smallint NOT NULL,
  comment text,
  created_at timestamptz NOT NULL,
  hidden_at timestamptz,
  hidden_by uuid,
  CONSTRAINT ratings_ratee_kind_check CHECK (ratee_kind IN ('provider', 'carrier')),
  CONSTRAINT ratings_score_check CHECK (score BETWEEN 1 AND 5),
  CONSTRAINT ratings_comment_length_check CHECK (comment IS NULL OR char_length(comment) BETWEEN 1 AND 500),
  CONSTRAINT ratings_hidden_check CHECK ((hidden_at IS NULL) = (hidden_by IS NULL)),
  CONSTRAINT ratings_rater_not_ratee_check CHECK (rater_id <> ratee_id),
  CONSTRAINT ratings_order_ratee_unique UNIQUE (order_id, ratee_kind)
);
CREATE INDEX ratings_ratee_idx ON trust.ratings (ratee_id, ratee_kind);

-- Running totals, updated atomically in the same transaction as each rating (no recount).
CREATE TABLE trust.reputations (
  subject_id uuid NOT NULL,
  subject_kind text NOT NULL,
  rating_sum bigint NOT NULL,
  ratings_count integer NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (subject_id, subject_kind),
  CONSTRAINT reputations_kind_check CHECK (subject_kind IN ('provider', 'carrier')),
  CONSTRAINT reputations_totals_check CHECK (
    ratings_count >= 0 AND rating_sum BETWEEN ratings_count AND ratings_count * 5
  )
);

-- Internal staff metrics per carrier (who controls punctuality), fed by OrderDelivered.
-- counted_deliveries makes each order count once, as at-least-once delivery requires.
CREATE TABLE trust.carrier_delivery_stats (
  carrier_id uuid PRIMARY KEY,
  delivered_count integer NOT NULL,
  with_window_count integer NOT NULL,
  on_time_count integer NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT carrier_delivery_stats_counts_check CHECK (
    delivered_count >= with_window_count AND with_window_count >= on_time_count AND on_time_count >= 0
  )
);
CREATE TABLE trust.counted_deliveries (
  order_id uuid PRIMARY KEY,
  counted_at timestamptz NOT NULL
);

-- Manual verification of providers (AGENTS §23.8 still open: no documents).
CREATE TABLE trust.verifications (
  provider_id uuid PRIMARY KEY,
  status text NOT NULL,
  note text,
  checks jsonb,
  reason text,
  requested_at timestamptz,
  reviewed_by uuid,
  reviewed_at timestamptz,
  version integer NOT NULL,
  CONSTRAINT verifications_status_check CHECK (
    status IN ('unverified', 'pending', 'verified', 'rejected', 'revoked')
  ),
  CONSTRAINT verifications_note_check CHECK (note IS NULL OR char_length(note) <= 300),
  CONSTRAINT verifications_reason_check CHECK (
    (status IN ('rejected', 'revoked')) = (reason IS NOT NULL) AND char_length(coalesce(reason, '')) <= 300
  ),
  CONSTRAINT verifications_verified_check CHECK (
    status <> 'verified' OR (checks IS NOT NULL AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
  )
);
CREATE INDEX verifications_status_idx ON trust.verifications (status, requested_at);
