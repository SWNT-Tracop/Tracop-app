import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';

const describeDocker =
  process.env.TRACOP_TESTCONTAINER_AVAILABLE === 'true' ? describe : describe.skip;

/** pg_dump (custom format, as scripts/backup/pg-backup.sh) and pg_restore into a fresh database. */
describeDocker('backup and restore (pg_dump / pg_restore on PostgreSQL 16)', () => {
  let container: StartedPostgreSqlContainer;
  let source: pg.Pool;
  let restored: pg.Pool;

  const exec = async (command: string[]) => {
    const result = await container.exec(command, { env: { PGPASSWORD: container.getPassword() } });
    if (result.exitCode !== 0) throw new Error(`${command[0]} failed: ${result.output}`);
    return result.output;
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    source = new pg.Pool({ connectionString: container.getConnectionUri() });
    await source.query('CREATE SCHEMA IF NOT EXISTS shared');
    await source.query(
      'CREATE TABLE IF NOT EXISTS shared.schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    for (const file of (await readdir(resolve('drizzle')))
      .filter((name) => /^\d+.*\.sql$/.test(name))
      .sort()) {
      await source.query(await readFile(resolve('drizzle', file), 'utf8'));
      await source.query('INSERT INTO shared.schema_migrations (id) VALUES ($1)', [file]);
    }
    // Synthetic rows in tables with triggers, sequences and append-only rules.
    await source.query(
      `INSERT INTO identity.users (id, role, full_name, phone, status, locale, created_at, updated_at)
       VALUES ('0190f47a-8b45-7cc2-9a1e-0000000000a1', 'buyer', 'Persona sintética', '+573000000099', 'active', 'es-CO', now(), now())`,
    );
    await source.query(
      `INSERT INTO identity.consents (id, user_id, policy_type, version, accepted_at, channel)
       VALUES ('0190f47a-8b45-7cc2-9a1e-0000000000a2', '0190f47a-8b45-7cc2-9a1e-0000000000a1', 'privacy', 'v0-draft', now(), 'app')`,
    );
    await source.query(
      `INSERT INTO sync.change_log (entity, entity_id, op, payload, occurred_at)
       VALUES ('category', '0190f47a-8b45-7cc2-9a1e-0000000000a3', 'upsert', '{}', now())`,
    );
  }, 180_000);

  afterAll(async () => {
    await restored?.end();
    await source?.end();
    await container?.stop();
  });

  it('restores every migration, the data, the sequences and the append-only triggers', async () => {
    const user = container.getUsername();
    const database = container.getDatabase();
    await exec([
      'pg_dump',
      '--format=custom',
      '--compress=6',
      '--no-owner',
      '-U',
      user,
      '-d',
      database,
      '-f',
      '/tmp/backup.dump',
    ]);
    await exec(['createdb', '-U', user, 'restored']);
    await exec([
      'pg_restore',
      '--no-owner',
      '--exit-on-error',
      '-U',
      user,
      '-d',
      'restored',
      '/tmp/backup.dump',
    ]);
    const uri = new URL(container.getConnectionUri());
    uri.pathname = '/restored';
    restored = new pg.Pool({ connectionString: uri.toString() });

    const counts = (pool: pg.Pool) =>
      pool.query(`SELECT (SELECT count(*)::int FROM shared.schema_migrations) AS migrations,
        (SELECT count(*)::int FROM identity.users) AS users, (SELECT count(*)::int FROM identity.consents) AS consents,
        (SELECT count(*)::int FROM sync.change_log) AS changes`);
    const [before, after] = await Promise.all([counts(source), counts(restored)]);
    expect(after.rows[0]).toEqual(before.rows[0]);
    expect(after.rows[0].migrations).toBe(
      (await readdir(resolve('drizzle'))).filter((name) => /^\d+.*\.sql$/.test(name)).length,
    );

    // The sequence continues after the restored rows (no duplicate server_seq).
    const next = await restored.query<{ server_seq: string }>(
      `INSERT INTO sync.change_log (entity, entity_id, op, payload, occurred_at)
       VALUES ('category', '0190f47a-8b45-7cc2-9a1e-0000000000a4', 'upsert', '{}', now()) RETURNING server_seq::text`,
    );
    const max = await source.query<{ max: string }>(
      'SELECT max(server_seq)::text AS max FROM sync.change_log',
    );
    expect(BigInt(next.rows[0]!.server_seq)).toBeGreaterThan(BigInt(max.rows[0]!.max));
    // Append-only rules survive: consents cannot be changed in the restored database either.
    await expect(restored.query(`DELETE FROM identity.consents`)).rejects.toThrow(/append-only/);
  }, 120_000);
});
