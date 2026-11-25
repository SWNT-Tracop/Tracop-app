-- Indexes for the identity retention job (see IdentityRetentionRepository).
CREATE INDEX otp_codes_expires_at_idx ON identity.otp_codes (expires_at);
CREATE INDEX sessions_expires_at_idx ON identity.sessions (expires_at);
CREATE INDEX sessions_revoked_at_idx ON identity.sessions (revoked_at) WHERE revoked_at IS NOT NULL;
CREATE INDEX rate_limit_counters_window_start_idx ON identity.rate_limit_counters (window_start);
