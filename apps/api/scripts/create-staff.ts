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

if (process.env.NODE_ENV === 'test') throw new Error('identity:create-staff is disabled in test.');
if (process.env.NODE_ENV === 'production' && !confirmed)
  throw new Error('Pass --confirm to create a staff user in production.');
if (!phoneValue || !fullName || !role || !['operator', 'finance', 'admin'].includes(role)) {
  throw new Error(
    'Usage: pnpm identity:create-staff --phone <E.164> --name <name> --role <operator|finance|admin> [--confirm]',
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

try {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
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
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  process.stdout.write(`Created staff user ${user.props.id} with role ${role}.\n`);
} finally {
  await pool.end();
}
