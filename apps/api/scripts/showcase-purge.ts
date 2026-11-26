/**
 * Removes the showcase seeded by `showcase-seed`: cancels the lots still on offer and retires
 * the 31 accounts the way identity retention does (phone replaced by a pseudonym, name cleared,
 * sessions, devices, links and provider profiles removed). Orders, payments, the ledger, ratings
 * and the audit log are kept: they are immutable by design. Demo profile only.
 *   node dist/scripts/showcase-purge.js --confirm
 */
import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { createId } from '../src/shared/kernel/ids.js';
import { SHOWCASE_SIZE, showcasePhone } from './showcase-plan.js';

const profile = process.env.APP_PROFILE ?? 'development';
if (process.env.NODE_ENV === 'production' || !['development', 'demo'].includes(profile))
  throw new Error('showcase-purge only runs in the development or demo profile.');
if (!process.argv.includes('--confirm'))
  throw new Error('Pass --confirm to purge the showcase accounts.');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');

const phones = Array.from({ length: SHOWCASE_SIZE }, (_, i) => showcasePhone(i));
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

try {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM identity.users WHERE phone = ANY($1::text[]) AND full_name LIKE '[DEMO]%'`,
      [phones],
    );
    const ids = rows.map(({ id }) => id);
    const lots = await client.query<{ id: string; provider_id: string; version: number }>(
      `UPDATE catalog.lots SET status = 'cancelled', version = version + 1, updated_at = now()
       WHERE provider_id = ANY($1::uuid[]) AND status IN ('draft', 'published', 'reserved')
         AND deleted_at IS NULL
       RETURNING id, provider_id, version`,
      [ids],
    );
    for (const lot of lots.rows)
      await client.query(
        `INSERT INTO sync.change_log (entity, entity_id, op, payload, owner_user_id, occurred_at)
         VALUES ('lot', $1, 'cancel', $2::jsonb, NULL, now())`,
        [lot.id, JSON.stringify({ id: lot.id, status: 'cancelled', version: lot.version })],
      );
    // Carrier plates are unique among active carriers: free them for a new seed.
    await client.query(
      `UPDATE logistics.carriers SET deleted_at = now(), updated_at = now()
       WHERE user_id = ANY($1::uuid[]) AND deleted_at IS NULL`,
      [ids],
    );
    for (const table of ['sessions', 'devices', 'otp_codes', 'channel_links', 'provider_profiles'])
      await client.query(`DELETE FROM identity.${table} WHERE user_id = ANY($1::uuid[])`, [ids]);
    for (const id of ids) {
      const pseudonym = `expired:${createHash('sha256').update(`showcase:${id}`).digest('hex')}`;
      await client.query(
        `UPDATE identity.users SET status = 'expired', phone = $2, full_name = '',
           updated_at = now(), deleted_at = now() WHERE id = $1`,
        [id, pseudonym],
      );
      await client.query(
        `INSERT INTO backoffice.audit_log (id, actor_id, actor_role, action, entity, entity_id, before, after, at)
         VALUES ($1, NULL, 'system', 'showcase.purge', 'user', $2, NULL, '{"status":"expired"}'::jsonb, now())`,
        [createId(), id],
      );
    }
    await client.query('COMMIT');
    process.stdout.write(
      `showcase-purge OK: ${ids.length} accounts retired, ${lots.rowCount} lots cancelled\n`,
    );
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
