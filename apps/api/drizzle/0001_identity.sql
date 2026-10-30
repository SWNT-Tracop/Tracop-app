CREATE SCHEMA IF NOT EXISTS identity;

CREATE TABLE IF NOT EXISTS shared.schema_migrations (
  id text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS identity.users (
  id uuid PRIMARY KEY,
  role text NOT NULL CHECK (role IN ('producer','supplier','buyer','carrier','operator','finance','admin')),
  full_name text NOT NULL,
  phone text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending_verification','active','suspended')),
  locale text NOT NULL DEFAULT 'es-CO',
  phone_verified_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique ON identity.users(phone);

CREATE TABLE IF NOT EXISTS identity.channel_links (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES identity.users(id),
  channel text NOT NULL,
  channel_user_id text NOT NULL,
  verified_at timestamptz,
  created_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS channel_links_channel_user_unique ON identity.channel_links(channel, channel_user_id);

CREATE TABLE IF NOT EXISTS identity.devices (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES identity.users(id),
  platform text NOT NULL CHECK (platform IN ('ios','android','web','other')),
  push_token text,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL,
  UNIQUE (user_id, id)
);
CREATE INDEX IF NOT EXISTS devices_user_id_idx ON identity.devices(user_id);

CREATE TABLE IF NOT EXISTS identity.otp_codes (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES identity.users(id),
  code_hash text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('registration','login')),
  attempts int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts int NOT NULL CHECK (max_attempts > 0),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS otp_codes_user_purpose_created_idx ON identity.otp_codes(user_id, purpose, created_at DESC);

CREATE TABLE IF NOT EXISTS identity.sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES identity.users(id),
  device_id uuid NOT NULL,
  family_id uuid NOT NULL,
  refresh_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  rotated_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL,
  FOREIGN KEY (user_id, device_id) REFERENCES identity.devices(user_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS sessions_refresh_hash_unique ON identity.sessions(refresh_hash);
CREATE INDEX IF NOT EXISTS sessions_family_id_idx ON identity.sessions(family_id);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON identity.sessions(user_id);

CREATE TABLE IF NOT EXISTS identity.provider_profiles (
  user_id uuid PRIMARY KEY REFERENCES identity.users(id),
  display_name text NOT NULL,
  municipality text,
  department text,
  lat double precision,
  lng double precision,
  description text
);

CREATE TABLE IF NOT EXISTS identity.consents (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES identity.users(id),
  policy_type text NOT NULL,
  version text NOT NULL,
  accepted_at timestamptz NOT NULL,
  channel text NOT NULL,
  UNIQUE (user_id, policy_type, version)
);
CREATE INDEX IF NOT EXISTS consents_user_id_idx ON identity.consents(user_id);

CREATE TABLE IF NOT EXISTS identity.rate_limit_counters (
  key_hash text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  count int NOT NULL CHECK (count >= 0)
);
