import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://tracop:tracop@localhost:5432/tracop' });
try {
  const sql = await readFile(resolve('drizzle/0000_initial-schemas.sql'), 'utf8');
  await pool.query(sql);
  process.stdout.write('Initial schemas migration applied.\n');
} finally {
  await pool.end();
}
