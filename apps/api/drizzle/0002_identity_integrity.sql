CREATE INDEX IF NOT EXISTS channel_links_user_id_idx ON identity.channel_links(user_id);

CREATE OR REPLACE FUNCTION identity.reject_consent_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'identity.consents is append-only';
END;
$$;

DROP TRIGGER IF EXISTS identity_consents_append_only ON identity.consents;
CREATE TRIGGER identity_consents_append_only
  BEFORE UPDATE OR DELETE ON identity.consents
  FOR EACH ROW EXECUTE FUNCTION identity.reject_consent_mutation();
