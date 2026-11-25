CREATE SCHEMA IF NOT EXISTS backoffice;

-- Sensitive staff actions (AGENTS §5.20), written in the same transaction as the change.
-- ip_hash is an HMAC of the client address (Ley 1581: the address itself is never stored);
-- before/after hold only the changed fields, never personal data. Append-only.
CREATE TABLE backoffice.audit_log (
  id uuid PRIMARY KEY,
  actor_id uuid,
  actor_role text NOT NULL,
  action text NOT NULL,
  entity text NOT NULL,
  entity_id text NOT NULL,
  before jsonb,
  after jsonb,
  at timestamptz NOT NULL,
  ip_hash text,
  request_id uuid,
  CONSTRAINT audit_log_action_check CHECK (action ~ '^[a-z_]+(\.[a-z_]+)+$' AND char_length(action) <= 64),
  CONSTRAINT audit_log_entity_check CHECK (char_length(entity) BETWEEN 1 AND 64),
  CONSTRAINT audit_log_entity_id_check CHECK (char_length(entity_id) BETWEEN 1 AND 128),
  CONSTRAINT audit_log_actor_role_check CHECK (char_length(actor_role) BETWEEN 1 AND 32),
  CONSTRAINT audit_log_ip_hash_check CHECK (ip_hash IS NULL OR ip_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT audit_log_payload_check CHECK (
    (before IS NULL OR jsonb_typeof(before) = 'object')
    AND (after IS NULL OR jsonb_typeof(after) = 'object')
  )
);
CREATE INDEX audit_log_at_idx ON backoffice.audit_log (at DESC, id DESC);
CREATE INDEX audit_log_entity_idx ON backoffice.audit_log (entity, entity_id, at DESC);
CREATE INDEX audit_log_actor_idx ON backoffice.audit_log (actor_id, at DESC);

CREATE FUNCTION backoffice.reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON backoffice.audit_log
  FOR EACH ROW EXECUTE FUNCTION backoffice.reject_mutation();

-- Run-time business parameters; a missing row means the environment default. Values are
-- integer strings (amounts in COP, rates in basis points, durations in hours).
CREATE TABLE backoffice.parameters (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT parameters_key_check CHECK (key IN (
    'order.commission_rate_bps', 'order.freight_cop', 'order.quote_ttl_hours',
    'order.reservation_ttl_hours', 'payment.claim_window_hours',
    'payment.rejection_grace_hours', 'catalog.product_proposal_pending_limit'
  )),
  CONSTRAINT parameters_value_check CHECK (value ~ '^-?(0|[1-9][0-9]{0,18})$')
);
