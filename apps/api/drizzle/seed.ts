import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { Pool } from 'pg';
import { createId } from '../src/shared/kernel/ids.js';
import { PhoneNumber } from '../src/modules/identity/domain/phone-number.js';
import { User, type UserEvent, type UserRole } from '../src/modules/identity/domain/user.js';

const envPath = resolve('../../.env');
if (existsSync(envPath)) loadEnvFile(envPath);
if (process.env.NODE_ENV !== 'development')
  throw new Error('db:seed is only allowed in development.');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');

const roles: readonly UserRole[] = [
  'producer',
  'supplier',
  'buyer',
  'carrier',
  'operator',
  'finance',
  'admin',
];
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const now = new Date();

try {
  for (const [index, role] of roles.entries()) {
    const phone = PhoneNumber.parse(`+5730000000${String(index + 1).padStart(2, '0')}`);
    if (!phone.ok) throw phone.error;
    const user = ['operator', 'finance', 'admin'].includes(role)
      ? User.createStaff(
          {
            id: createId(),
            role,
            phone: phone.value,
            fullName: `Synthetic ${role}`,
            locale: 'es-CO',
            createdAt: now,
          },
          now,
        )
      : User.register(
          {
            id: createId(),
            role,
            phone: phone.value,
            fullName: `Synthetic ${role}`,
            locale: 'es-CO',
            createdAt: now,
          },
          now,
        );
    const events: UserEvent[] = [user.registeredEvent()];
    if (user.props.status !== 'active') events.push(user.verifyPhone(now));
    const inserted = await pool.query(
      `INSERT INTO identity.users (id, role, full_name, phone, status, locale, phone_verified_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (phone) DO NOTHING RETURNING id`,
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
    if (inserted.rowCount) {
      for (const event of events) {
        await pool.query(
          `INSERT INTO shared.outbox_events (id, aggregate, type, payload, created_at)
           VALUES ($1, $2, $3, $4::jsonb, $5)`,
          [createId(), user.props.id, event.type, JSON.stringify({ ...event }), now],
        );
      }
    }
  }
  process.stdout.write('Synthetic identity users seeded.\n');
} finally {
  await pool.end();
}
