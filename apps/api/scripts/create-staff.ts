import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { Pool } from 'pg';
import { createId } from '../src/shared/kernel/ids.js';
import { User, type UserRole } from '../src/modules/identity/domain/user.js';
import { PhoneNumber } from '../src/modules/identity/domain/phone-number.js';

const envPath = resolve('../../.env');
if (existsSync(envPath)) loadEnvFile(envPath);

const values = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const index = values.indexOf(name);
  return index < 0 ? undefined : values[index + 1];
};
const role = option('--role') as UserRole | undefined;
const phoneValue = option('--phone');
const fullName = option('--name');
const confirmed = values.includes('--confirm');
// An account that already exists with that phone (for example someone who signed up in the app)
// becomes staff instead of failing on the unique phone.
const promote = values.includes('--promote');

if (process.env.NODE_ENV === 'test') throw new Error('identity:create-staff is disabled in test.');
if (process.env.NODE_ENV === 'production' && !confirmed)
  throw new Error('Pass --confirm to create a staff user in production.');
if (!phoneValue || !fullName || !role || !['operator', 'finance', 'admin'].includes(role)) {
  throw new Error(
    'Usage: pnpm identity:create-staff --phone <E.164> --name <name> --role <operator|finance|admin> [--promote] [--confirm]',
  );
}
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');

const phone = PhoneNumber.parse(phoneValue, (process.env.ALLOWED_COUNTRY_CODES ?? '57').split(','));
if (!phone.ok) throw phone.error;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const now = new Date();
const user = User.createStaff(
  { id: createId(), role, phone: phone.value, fullName, locale: 'es-CO', createdAt: now },
  now,
);
const event = user.registeredEvent();

let outcome = `Created staff user ${user.props.id} with role ${role}.`;
try {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query<{ id: string; role: string; status: string }>(
      `SELECT id, role, status FROM identity.users WHERE phone = $1 FOR UPDATE`,
      [phone.value.value],
    );
    const found = existing.rows[0];
    if (found && !promote)
      throw new Error('An account already uses that phone. Pass --promote to make it staff.');
    if (found) {
      if (found.status === 'expired') throw new Error('That account was retired.');
      outcome = `Promoted the existing account ${found.id} from ${found.role} to ${role}.`;
      await client.query(
        `UPDATE identity.users SET role = $2, full_name = $3, status = 'active',
           phone_verified_at = coalesce(phone_verified_at, $4), updated_at = $4 WHERE id = $1`,
        [found.id, role, fullName, now],
      );
      // The person signs in again with the new role.
      await client.query(
        `UPDATE identity.sessions SET revoked_at = $2, revoked_reason = 'staff.promote'
         WHERE user_id = $1 AND revoked_at IS NULL`,
        [found.id, now],
      );
      await client.query(
        `INSERT INTO backoffice.audit_log (id, actor_id, actor_role, action, entity, entity_id, before, after, at)
         VALUES ($1, NULL, 'system', 'staff.promote', 'user', $2, $3::jsonb, $4::jsonb, $5)`,
        [
          createId(),
          found.id,
          JSON.stringify({ role: found.role, status: found.status }),
          JSON.stringify({ role, status: 'active' }),
          now,
        ],
      );
    } else {
      await client.query(
        `INSERT INTO identity.users (id, role, full_name, phone, status, locale, phone_verified_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          user.props.id,
          user.props.role,
          user.props.fullName,
          user.props.phone.value,
          user.props.status,
          user.props.locale,
          user.props.phoneVerifiedAt,
          user.props.createdAt,
          user.props.updatedAt,
        ],
      );
      await client.query(
        `INSERT INTO shared.outbox_events (id, aggregate, type, payload, created_at)
       VALUES ($1, $2, $3, $4::jsonb, $5)`,
        [createId(), user.props.id, event.type, JSON.stringify({ ...event }), now],
      );
      // A new staff account is a sensitive action: audited in the same transaction, as the system
      // (there is no signed-in actor in the CLI). Neither the phone nor the name is recorded.
      await client.query(
        `INSERT INTO backoffice.audit_log (id, actor_id, actor_role, action, entity, entity_id, before, after, at)
       VALUES ($1, NULL, 'system', 'staff.create', 'user', $2, NULL, $3::jsonb, $4)`,
        [createId(), user.props.id, JSON.stringify({ role: user.props.role }), now],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  process.stdout.write(`${outcome}\n`);
} finally {
  await pool.end();
}
