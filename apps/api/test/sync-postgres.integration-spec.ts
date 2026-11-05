import type { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import { AppModule } from '../src/bootstrap/app.module.js';
import { DATABASE_POOL } from '../src/shared/infra/tokens.js';
import { SyncService } from '../src/modules/sync/index.js';
import { describePostgres } from './postgres-suite.js';

describePostgres('sync persistence and visibility (shared PostgreSQL Testcontainers)', () => {
  let app: INestApplicationContext;
  let pool: pg.Pool;
  let sync: SyncService;
  const owner = '00000000-0000-7000-8000-000000000001';
  const other = '00000000-0000-7000-8000-000000000002';

  beforeAll(async () => {
    app = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await app.init();
    pool = app.get(DATABASE_POOL) as pg.Pool;
    sync = app.get(SyncService);
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE sync.processed_operations, sync.change_log');
  });

  it('prints the applied PostgreSQL schema definition for the sync tables', async () => {
    const columns = await pool.query(
      `SELECT table_name, column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'sync' ORDER BY table_name, ordinal_position`,
    );
    const indexes = await pool.query(
      `SELECT tablename, indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'sync' ORDER BY tablename, indexname`,
    );
    process.stdout.write(
      `Applied sync columns (PostgreSQL catalog):\n${JSON.stringify(columns.rows, null, 2)}\n`,
    );
    process.stdout.write(
      `Applied sync indexes (PostgreSQL catalog):\n${JSON.stringify(indexes.rows, null, 2)}\n`,
    );
    expect(columns.rows.map(({ table_name }) => table_name)).toContain('change_log');
    expect(columns.rows.map(({ table_name }) => table_name)).toContain('processed_operations');
    expect(
      indexes.rows.some(({ indexname }) => indexname === 'change_log_owner_server_seq_idx'),
    ).toBe(true);
  });

  it('enforces sync operation, outcome, hash, and size constraints in PostgreSQL', async () => {
    const changeId = '00000000-0000-7000-8000-000000000021';
    await expect(
      pool.query(
        `INSERT INTO sync.change_log (entity, entity_id, op, payload, occurred_at)
       VALUES ('lot', $1, 'unknown', '{}', now())`,
        [changeId],
      ),
    ).rejects.toThrow();
    await expect(
      pool.query(
        `INSERT INTO sync.change_log (entity, entity_id, op, payload, occurred_at)
       VALUES (repeat('x', 65), $1, 'upsert', '{}', now())`,
        [changeId],
      ),
    ).rejects.toThrow();
    await expect(
      pool.query(
        `INSERT INTO sync.change_log (entity, entity_id, op, payload, occurred_at)
       VALUES ('lot', $1, 'upsert', jsonb_build_object('padding', repeat('x', 262145)), now())`,
        [changeId],
      ),
    ).rejects.toThrow();
    await expect(
      pool.query(
        `INSERT INTO sync.processed_operations
       (op_id, device_id, user_id, entity, entity_id, result, payload_hash, processed_at)
       VALUES ($1, $2, $3, 'lot', $4, '{"status":"unknown"}', repeat('a', 64), now())`,
        [
          '00000000-0000-7000-8000-000000000022',
          '00000000-0000-7000-8000-000000000023',
          owner,
          changeId,
        ],
      ),
    ).rejects.toThrow();
    await expect(
      pool.query(
        `INSERT INTO sync.processed_operations
       (op_id, device_id, user_id, entity, entity_id, result, payload_hash, processed_at)
       VALUES ($1, $2, $3, 'lot', $4, '{"status":"applied"}', 'bad-hash', now())`,
        [
          '00000000-0000-7000-8000-000000000024',
          '00000000-0000-7000-8000-000000000025',
          owner,
          changeId,
        ],
      ),
    ).rejects.toThrow();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('does not advance the visible pull cursor over an uncommitted change, then delivers it after commit', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', [1_414_677_712, 1]);
      await client.query(
        `INSERT INTO sync.change_log (entity, entity_id, op, payload, owner_user_id, occurred_at)
         VALUES ('lot', $1, 'upsert', '{"version":1}', $2, now())`,
        ['00000000-0000-7000-8000-000000000003', owner],
      );

      const whileHeld = await sync.pull({ sub: owner, role: 'producer', did: 'device-a' }, '0', 20);
      expect(whileHeld).toMatchObject({ changes: [], nextCursor: '0', hasMore: false });

      await client.query('COMMIT');
      const afterCommit = await sync.pull(
        { sub: owner, role: 'producer', did: 'device-a' },
        '0',
        20,
      );
      expect(afterCommit.changes).toHaveLength(1);
      expect(afterCommit.changes[0]).toMatchObject({ entity: 'lot', payload: { version: 1 } });
      expect(BigInt(afterCommit.nextCursor)).toBeGreaterThan(0n);
    } finally {
      client.release();
    }
  });

  it('returns global taxonomy and own lots only, and explains pull with and without other users’ rows', async () => {
    await pool.query(
      `INSERT INTO sync.change_log (entity, entity_id, op, payload, owner_user_id, occurred_at)
       VALUES ('lot', '00000000-0000-7000-8000-000000000003', 'upsert', '{"version":1}', $1, now()),
              ('lot', '00000000-0000-7000-8000-000000000004', 'upsert', '{"version":1}', $2, now()),
              ('lot', '00000000-0000-7000-8000-000000000006', 'cancel', '{"tombstone":true}', $2, now()),
              ('category', '00000000-0000-7000-8000-000000000007', 'upsert', '{"name":"Tubérculos"}', NULL, now())`,
      [owner, other],
    );
    const privateRows = await sync.pull({ sub: owner, role: 'producer', did: 'device-a' }, '0', 20);
    expect(privateRows.changes.map(({ entityId }) => entityId)).toEqual([
      '00000000-0000-7000-8000-000000000003',
      '00000000-0000-7000-8000-000000000007',
    ]);
    const thirdUserRows = await sync.pull(
      { sub: '00000000-0000-7000-8000-000000000009', role: 'producer', did: 'device-c' },
      '0',
      20,
    );
    expect(thirdUserRows.changes.map(({ entityId }) => entityId)).toEqual([
      '00000000-0000-7000-8000-000000000007',
    ]);

    const withoutPrivate = await pool.query(
      `EXPLAIN (ANALYZE, COSTS, VERBOSE, BUFFERS)
       SELECT server_seq FROM sync.change_log
       WHERE server_seq > 0 AND (owner_user_id IS NULL OR owner_user_id = $1::uuid)
       ORDER BY server_seq LIMIT 21`,
      [owner],
    );
    await pool.query(
      `INSERT INTO sync.change_log (entity, entity_id, op, payload, owner_user_id, occurred_at)
       VALUES ('lot', '00000000-0000-7000-8000-000000000005', 'upsert', '{"version":1}', $1, now())`,
      [other],
    );
    const withPrivate = await pool.query(
      `EXPLAIN (ANALYZE, COSTS, VERBOSE, BUFFERS)
       SELECT server_seq FROM sync.change_log
       WHERE server_seq > 0 AND (owner_user_id IS NULL OR owner_user_id = $1::uuid)
       ORDER BY server_seq LIMIT 21`,
      [owner],
    );
    process.stdout.write(
      `Sync pull EXPLAIN without private rows:\n${withoutPrivate.rows.map((row) => row['QUERY PLAN']).join('\n')}\n`,
    );
    process.stdout.write(
      `Sync pull EXPLAIN with private rows:\n${withPrivate.rows.map((row) => row['QUERY PLAN']).join('\n')}\n`,
    );
  });

  it('paginates over visible changes without losing later rows across private sequence gaps', async () => {
    await pool.query(
      `INSERT INTO sync.change_log (entity, entity_id, op, payload, owner_user_id, occurred_at)
       VALUES ('lot', '00000000-0000-7000-8000-000000000011', 'upsert', '{"version":1}', $1, now()),
              ('lot', '00000000-0000-7000-8000-000000000012', 'upsert', '{"version":1}', $2, now()),
              ('category', '00000000-0000-7000-8000-000000000013', 'upsert', '{"name":"Frutas"}', NULL, now()),
              ('lot', '00000000-0000-7000-8000-000000000014', 'upsert', '{"version":1}', $1, now())`,
      [owner, other],
    );

    const pageOne = await sync.pull({ sub: owner, role: 'producer', did: 'device-a' }, '0', 1);
    const pageTwo = await sync.pull(
      { sub: owner, role: 'producer', did: 'device-a' },
      pageOne.nextCursor,
      1,
    );
    const pageThree = await sync.pull(
      { sub: owner, role: 'producer', did: 'device-a' },
      pageTwo.nextCursor,
      1,
    );
    expect(
      [...pageOne.changes, ...pageTwo.changes, ...pageThree.changes].map(
        (change) => change.entityId,
      ),
    ).toEqual([
      '00000000-0000-7000-8000-000000000011',
      '00000000-0000-7000-8000-000000000013',
      '00000000-0000-7000-8000-000000000014',
    ]);
    expect(pageThree.hasMore).toBe(false);
  });
});
