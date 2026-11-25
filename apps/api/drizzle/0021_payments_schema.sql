CREATE SCHEMA IF NOT EXISTS payments;

-- One payment per order at a time: a rejected proof ends its payment and the buyer starts a
-- new one. Money is integer COP.
CREATE TABLE payments.payments (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL,
  buyer_id uuid NOT NULL,
  provider_id uuid NOT NULL,
  method text NOT NULL,
  status text NOT NULL,
  subtotal bigint NOT NULL,
  freight bigint NOT NULL,
  commission bigint NOT NULL,
  total bigint NOT NULL,
  provider_net bigint NOT NULL,
  version integer NOT NULL,
  proof_incoming_key text,
  proof_upload_expires_at timestamptz,
  proof_key text,
  proof_uploaded_at timestamptz,
  reviewed_by uuid,
  reviewed_at timestamptz,
  rejection_reason text,
  held_at timestamptz,
  carrier_id uuid,
  dispute_reason text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT payments_method_check CHECK (method IN ('transfer', 'nequi')),
  CONSTRAINT payments_status_check CHECK (status IN (
    'pending', 'proof_uploaded', 'verified', 'held', 'settled', 'rejected', 'disputed', 'refunded'
  )),
  CONSTRAINT payments_amounts_check CHECK (
    subtotal >= 0 AND freight >= 0 AND commission >= 0 AND provider_net >= 0 AND total > 0
    AND total = subtotal + freight AND provider_net = subtotal - commission
  ),
  CONSTRAINT payments_version_check CHECK (version >= 1),
  CONSTRAINT payments_proof_check CHECK (status = 'pending' OR proof_key IS NOT NULL),
  CONSTRAINT payments_rejection_check CHECK (
    status <> 'rejected' OR (rejection_reason IS NOT NULL AND reviewed_by IS NOT NULL)
  ),
  CONSTRAINT payments_reason_length_check CHECK (
    char_length(coalesce(rejection_reason, '')) <= 500
    AND char_length(coalesce(dispute_reason, '')) <= 500
  )
);

CREATE UNIQUE INDEX payments_open_order_unique
  ON payments.payments (order_id) WHERE status <> 'rejected';
CREATE INDEX payments_order_idx ON payments.payments (order_id, created_at);
CREATE INDEX payments_status_idx ON payments.payments (status, held_at);
CREATE INDEX payments_buyer_idx ON payments.payments (buyer_id, created_at);

-- Append-only trail of every payment transition and who made it (audit until backoffice).
CREATE TABLE payments.payment_events (
  id uuid PRIMARY KEY,
  payment_id uuid NOT NULL REFERENCES payments.payments(id),
  order_id uuid NOT NULL,
  type text NOT NULL,
  actor_id uuid,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  CONSTRAINT payment_events_type_check CHECK (type IN (
    'PaymentInitiated', 'PaymentProofUploaded', 'PaymentVerified', 'PaymentRejected',
    'PaymentHeld', 'PaymentDisputed', 'PaymentDisputeReleased', 'PaymentRefunded',
    'PaymentSettled', 'SettlementIssued', 'SettlementPaid'
  ))
);
CREATE INDEX payment_events_payment_idx ON payments.payment_events (payment_id, occurred_at);

-- One ledger transaction per (order, kind): the idempotency key of every posting.
CREATE TABLE payments.ledger_transactions (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL,
  payment_id uuid NOT NULL REFERENCES payments.payments(id),
  kind text NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT ledger_transactions_kind_check CHECK (kind IN (
    'payment_verified', 'delivery_confirmed', 'settlement_paid_producer',
    'settlement_paid_carrier', 'refund'
  )),
  CONSTRAINT ledger_transactions_order_kind_unique UNIQUE (order_id, kind)
);

CREATE TABLE payments.ledger_entries (
  id uuid PRIMARY KEY,
  transaction_id uuid NOT NULL REFERENCES payments.ledger_transactions(id),
  order_id uuid NOT NULL,
  account text NOT NULL,
  debit bigint NOT NULL,
  credit bigint NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT ledger_entries_account_check CHECK (account IN (
    'cash_held', 'payable_buyer_funds', 'payable_producer', 'payable_carrier', 'revenue_commission'
  )),
  CONSTRAINT ledger_entries_one_side_check CHECK (
    debit >= 0 AND credit >= 0 AND (debit = 0) <> (credit = 0)
  )
);
CREATE INDEX ledger_entries_transaction_idx ON payments.ledger_entries (transaction_id);
CREATE INDEX ledger_entries_order_idx ON payments.ledger_entries (order_id);

CREATE TABLE payments.settlements (
  id uuid PRIMARY KEY,
  payment_id uuid NOT NULL REFERENCES payments.payments(id),
  order_id uuid NOT NULL,
  beneficiary_id uuid NOT NULL,
  beneficiary_kind text NOT NULL,
  amount bigint NOT NULL,
  status text NOT NULL,
  issued_at timestamptz NOT NULL,
  paid_at timestamptz,
  paid_by uuid,
  reference text,
  version integer NOT NULL,
  CONSTRAINT settlements_kind_check CHECK (beneficiary_kind IN ('producer', 'carrier')),
  CONSTRAINT settlements_status_check CHECK (status IN ('issued', 'paid')),
  CONSTRAINT settlements_amount_check CHECK (amount > 0),
  CONSTRAINT settlements_paid_check CHECK (
    (status = 'issued' AND paid_at IS NULL AND paid_by IS NULL)
    OR (status = 'paid' AND paid_at IS NOT NULL AND paid_by IS NOT NULL)
  ),
  CONSTRAINT settlements_reference_length_check CHECK (char_length(coalesce(reference, '')) <= 100),
  CONSTRAINT settlements_payment_kind_unique UNIQUE (payment_id, beneficiary_kind)
);
CREATE INDEX settlements_beneficiary_idx ON payments.settlements (beneficiary_id, issued_at);
CREATE INDEX settlements_status_idx ON payments.settlements (status, issued_at);

-- Ledger rows and payment events are immutable.
CREATE FUNCTION payments.reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE TRIGGER ledger_entries_immutable BEFORE UPDATE OR DELETE ON payments.ledger_entries
  FOR EACH ROW EXECUTE FUNCTION payments.reject_mutation();
CREATE TRIGGER ledger_transactions_immutable BEFORE UPDATE OR DELETE ON payments.ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION payments.reject_mutation();
CREATE TRIGGER payment_events_immutable BEFORE UPDATE OR DELETE ON payments.payment_events
  FOR EACH ROW EXECUTE FUNCTION payments.reject_mutation();

-- Debits equal credits per transaction, checked at commit so all lines can be inserted first.
CREATE FUNCTION payments.assert_ledger_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  difference bigint;
  lines integer;
BEGIN
  SELECT coalesce(sum(debit), 0) - coalesce(sum(credit), 0), count(*)
    INTO difference, lines
    FROM payments.ledger_entries WHERE transaction_id = NEW.transaction_id;
  IF difference <> 0 OR lines < 2 THEN
    RAISE EXCEPTION 'ledger transaction % is not balanced', NEW.transaction_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON payments.ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION payments.assert_ledger_balanced();
