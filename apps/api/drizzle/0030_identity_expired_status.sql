-- Registrations never verified are expired by the worker: status 'expired', phone replaced
-- by a keyed hash (the number is free again and not kept in clear), name cleared.
ALTER TABLE identity.users DROP CONSTRAINT users_status_check;
ALTER TABLE identity.users ADD CONSTRAINT users_status_check
  CHECK (status IN ('pending_verification', 'active', 'suspended', 'expired'));
