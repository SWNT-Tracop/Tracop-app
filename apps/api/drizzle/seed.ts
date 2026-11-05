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
  const syntheticCategories = [
    { name: '[DEMO] Raíces y tubérculos', product: '[DEMO] Papa' },
    { name: '[DEMO] Frutas', product: '[DEMO] Mora' },
    { name: '[DEMO] Hortalizas', product: '[DEMO] Cebolla' },
  ];
  for (const item of syntheticCategories) {
    const found = await pool.query<{ id: string }>(
      `SELECT id FROM catalog.categories WHERE parent_id IS NULL AND lower(name) = lower($1) AND deleted_at IS NULL LIMIT 1`,
      [item.name],
    );
    const categoryId = found.rows[0]?.id ?? createId();
    if (!found.rowCount)
      await pool.query(
        `INSERT INTO catalog.categories (id, name, parent_id, depth, created_at, updated_at) VALUES ($1, $2, NULL, 1, $3, $3)`,
        [categoryId, item.name, now],
      );
    const productFound = await pool.query(
      `SELECT id FROM catalog.products WHERE category_id = $1 AND lower(name) = lower($2) AND deleted_at IS NULL LIMIT 1`,
      [categoryId, item.product],
    );
    if (!productFound.rowCount) {
      await pool.query(
        `INSERT INTO catalog.products (id, category_id, name, search_text, unit, attributes, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'kg', '{"synthetic":true}'::jsonb, $5, $5)`,
        [
          createId(),
          categoryId,
          item.product,
          item.product
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, ''),
          now,
        ],
      );
    }
  }
  process.stdout.write('Synthetic identity users seeded.\n');
} finally {
  await pool.end();
}
