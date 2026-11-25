/**
 * Outbox health for operators: events per type that are pending, retrying or dead-lettered,
 * the age of the oldest pending one, and deliveries per consumer. Counts only: no payloads.
 * Usage: pnpm --filter @tracop/api outbox:status
 */
import pg from 'pg';
import { loadAppEnvironment } from '../src/shared/infra/env.js';

const environment = loadAppEnvironment();
const pool = new pg.Pool({ connectionString: environment.DATABASE_URL, max: 1 });
try {
  const byType = await pool.query<{
    type: string;
    pending: number;
    retrying: number;
    dead_lettered: number;
    oldest_pending_seconds: number | null;
  }>(`
    SELECT type,
      count(*) FILTER (WHERE published_at IS NULL AND failed_at IS NULL AND attempts = 0)::int AS pending,
      count(*) FILTER (WHERE published_at IS NULL AND failed_at IS NULL AND attempts > 0)::int AS retrying,
      count(*) FILTER (WHERE failed_at IS NOT NULL)::int AS dead_lettered,
      floor(extract(epoch FROM now() - min(created_at) FILTER (WHERE published_at IS NULL AND failed_at IS NULL)))::int
        AS oldest_pending_seconds
    FROM shared.outbox_events
    GROUP BY type
    HAVING count(*) FILTER (WHERE published_at IS NULL) > 0
    ORDER BY type`);
  const consumers = await pool.query<{ consumer: string; delivered: number }>(`
    SELECT consumer, count(*)::int AS delivered FROM shared.outbox_deliveries GROUP BY consumer ORDER BY consumer`);
  const heartbeat = await pool.query<{ age_seconds: number | null }>(`
    SELECT floor(extract(epoch FROM now() - max(beat_at)))::int AS age_seconds FROM shared.worker_heartbeats`);
  process.stdout.write('Outbox (unpublished events by type)\n');
  if (byType.rows.length === 0) process.stdout.write('  none\n');
  for (const row of byType.rows)
    process.stdout.write(
      `  ${row.type.padEnd(28)} pending ${row.pending}  retrying ${row.retrying}  dead-lettered ${row.dead_lettered}` +
        `  oldest ${row.oldest_pending_seconds ?? '-'} s\n`,
    );
  process.stdout.write('Deliveries by consumer\n');
  for (const row of consumers.rows)
    process.stdout.write(`  ${row.consumer.padEnd(36)} ${row.delivered}\n`);
  const age = heartbeat.rows[0]?.age_seconds;
  process.stdout.write(
    `Worker heartbeat: ${age === null || age === undefined ? 'never' : `${age} s ago`}\n`,
  );
} finally {
  await pool.end();
}
