/**
 * Creates the two PostgreSQL roles of the least-privilege setup and sets their passwords:
 *
 *   tracop_owner  runs the migrations, so it creates schemas, tables, indexes and triggers.
 *   tracop_app    serves the API and the worker: rows, never schema changes.
 *
 * The passwords come from the environment and never reach a migration file; the grants live in
 * drizzle/0032_database_roles.sql, applied right after this script. It is idempotent: it
 * recreates nothing and only rotates the passwords it is given.
 *
 * It connects with the libpq variables the rest of the deployment already uses (the superuser
 * that owns the database), not with a URL, because a base64 password would need percent-encoding
 * inside one:
 *
 *   PGHOST=db PGUSER=postgres PGPASSWORD=... PGDATABASE=tracop \
 *   DB_OWNER_PASSWORD=... DB_APP_PASSWORD=... pnpm db:provision-roles
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import pg from 'pg';

const OWNER_ROLE = 'tracop_owner';
const APP_ROLE = 'tracop_app';
/** pg-boss creates and migrates its own tables when it starts, so the app role owns this one. */
const JOB_SCHEMA = 'pgboss';

const envPath = resolve('../../.env');
if (existsSync(envPath)) loadEnvFile(envPath);

const database = process.env.PGDATABASE ?? 'tracop';
const ownerPassword = process.env.DB_OWNER_PASSWORD;
const appPassword = process.env.DB_APP_PASSWORD;

if (!ownerPassword || !appPassword) {
  throw new Error('DB_OWNER_PASSWORD and DB_APP_PASSWORD must be set.');
}

const client = new pg.Client({
  host: process.env.PGHOST ?? 'localhost',
  port: process.env.PGPORT ? Number(process.env.PGPORT) : 5432,
  user: process.env.PGUSER ?? 'postgres',
  database,
  ...(process.env.PGPASSWORD ? { password: process.env.PGPASSWORD } : {}),
});
await client.connect();
try {
  for (const [role, password] of [
    [OWNER_ROLE, ownerPassword],
    [APP_ROLE, appPassword],
  ] as const) {
    const existing = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
    const passwordLiteral = client.escapeLiteral(password);
    await client.query(
      existing.rowCount === 0
        ? `CREATE ROLE "${role}" LOGIN PASSWORD ${passwordLiteral}`
        : `ALTER ROLE "${role}" LOGIN PASSWORD ${passwordLiteral}`,
    );
  }
  // The owner creates the module schemas; the app role only reads and writes their rows.
  await client.query(`GRANT CREATE ON DATABASE "${database}" TO "${OWNER_ROLE}"`);
  const jobSchema = await client.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [
    JOB_SCHEMA,
  ]);
  if (jobSchema.rowCount === 0) {
    await client.query(`CREATE SCHEMA "${JOB_SCHEMA}" AUTHORIZATION "${APP_ROLE}"`);
  } else {
    // pg-boss creates its tables inside this schema, so it must own it.
    await client.query(`ALTER SCHEMA "${JOB_SCHEMA}" OWNER TO "${APP_ROLE}"`);
  }
  process.stdout.write(`Roles ${OWNER_ROLE} and ${APP_ROLE} are ready in ${database}.\n`);
} finally {
  await client.end();
}
