import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type pg from 'pg';
import { PhoneNumber } from '../../src/modules/identity/domain/phone-number.js';
import { User } from '../../src/modules/identity/domain/user.js';
import { PASSWORDLESS_HASHER, TOKEN_SERVICE } from '../../src/modules/identity/ports/tokens.js';
import { createId } from '../../src/shared/kernel/ids.js';

export type StaffRole = 'operator' | 'finance' | 'admin';

/**
 * A staff account with a live session, as `identity:create-staff` would leave it, and an access
 * token for it. Staff roles cannot self-register, so tests seed them directly.
 */
export const createStaffAccount = async (
  app: INestApplication,
  pool: pg.Pool,
  role: StaffRole,
  phone: string,
): Promise<{ readonly token: string; readonly userId: string }> => {
  const now = new Date();
  const id = createId();
  const deviceId = createId();
  const sessionId = createId();
  const parsed = PhoneNumber.parse(phone);
  if (!parsed.ok) throw parsed.error;
  const user = User.createStaff(
    {
      id,
      role,
      phone: parsed.value,
      fullName: `Personal ${role}`,
      locale: 'es-CO',
      createdAt: now,
    },
    now,
  );
  await pool.query(
    `INSERT INTO identity.users (id, role, full_name, phone, status, locale, phone_verified_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'active', 'es-CO', $5, $5, $5)`,
    [id, role, user.props.fullName, phone, now],
  );
  await pool.query(
    `INSERT INTO identity.devices (id, user_id, platform, created_at) VALUES ($1, $2, 'web', $3)`,
    [deviceId, id, now],
  );
  await pool.query(
    `INSERT INTO identity.sessions (id, user_id, device_id, family_id, refresh_hash, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      sessionId,
      id,
      deviceId,
      createId(),
      app.get(PASSWORDLESS_HASHER).hashRefreshToken(randomBytes(32).toString('base64url')),
      new Date(now.getTime() + 3_600_000),
      now,
    ],
  );
  const token = await app.get(TOKEN_SERVICE).issueAccessToken(user.props, sessionId, deviceId, now);
  return { token, userId: id };
};
