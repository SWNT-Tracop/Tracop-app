import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import pg from 'pg';

const envPath = resolve('../../.env');
if (existsSync(envPath)) loadEnvFile(envPath);

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL must be set in the environment or repository .env file.');
}

const pool = new pg.Pool({ connectionString: databaseUrl });
try {
  await pool.query('CREATE SCHEMA IF NOT EXISTS shared');
  await pool.query(`CREATE TABLE IF NOT EXISTS shared.schema_migrations (
    id text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const appliedRows = await pool.query<{ id: string }>('SELECT id FROM shared.schema_migrations');
  const applied = new Set(appliedRows.rows.map(({ id }) => id));
  const migrationFiles = (await readdir(resolve('drizzle')))
    .filter((filename) => /^\d+.*\.sql$/.test(filename))
    .sort();

  for (const filename of migrationFiles) {
    if (applied.has(filename)) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(await readFile(resolve('drizzle', filename), 'utf8'));
      await client.query('INSERT INTO shared.schema_migrations (id) VALUES ($1)', [filename]);
      await client.query('COMMIT');
      process.stdout.write(`Applied migration ${filename}.\n`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
} finally {
  await pool.end();
}
