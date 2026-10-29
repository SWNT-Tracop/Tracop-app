import { readFile } from 'node:fs/promises';
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
  const sql = await readFile(resolve('drizzle/0000_initial-schemas.sql'), 'utf8');
  await pool.query(sql);
  process.stdout.write('Initial schemas migration applied.\n');
} finally {
  await pool.end();
}
