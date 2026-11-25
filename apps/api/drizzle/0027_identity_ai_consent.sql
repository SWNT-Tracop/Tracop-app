-- Consent to process a user's messages with AI (Ley 1581), per notice version. Append-only:
-- each row is a decision (accept or withdraw); the current status is the latest row for the
-- version. A separate table because identity.consents is unique per (user, policy, version),
-- which would forbid accepting again after a withdrawal.
CREATE TABLE identity.ai_consent_events (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES identity.users(id),
  version text NOT NULL,
  decision text NOT NULL,
  channel text NOT NULL,
  recorded_at timestamptz NOT NULL,
  CONSTRAINT ai_consent_events_decision_check CHECK (decision IN ('accept', 'withdraw')),
  CONSTRAINT ai_consent_events_version_check CHECK (char_length(version) BETWEEN 1 AND 64),
  CONSTRAINT ai_consent_events_channel_check CHECK (channel IN ('telegram', 'whatsapp', 'app'))
);
CREATE INDEX ai_consent_events_user_version_idx
  ON identity.ai_consent_events (user_id, version, recorded_at DESC, id DESC);

CREATE TRIGGER identity_ai_consent_events_append_only
  BEFORE UPDATE OR DELETE ON identity.ai_consent_events
  FOR EACH ROW EXECUTE FUNCTION identity.reject_consent_mutation();
