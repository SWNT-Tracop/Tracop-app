CREATE UNIQUE INDEX IF NOT EXISTS sessions_one_live_device_token_unique
  ON identity.sessions(user_id, device_id)
  WHERE revoked_at IS NULL AND rotated_at IS NULL;
