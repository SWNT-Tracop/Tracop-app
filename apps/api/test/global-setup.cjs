const { PostgreSqlContainer } = require('@testcontainers/postgresql');
const { readFile, writeFile } = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { Pool } = require('pg');

const statePath = join(tmpdir(), 'tracop-identity-test-container.json');

module.exports = async () => {
  let container;
  let pool;
  try {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await pool.query('CREATE SCHEMA IF NOT EXISTS shared');
    await pool.query(`CREATE TABLE IF NOT EXISTS shared.schema_migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    for (const filename of [
      '0000_initial-schemas.sql',
      '0001_identity.sql',
      '0002_identity_integrity.sql',
      '0003_identity_device_session_uniqueness.sql',
      '0004_messaging.sql',
      '0005_catalog.sql',
    ]) {
      await pool.query(await readFile(resolve('drizzle', filename), 'utf8'));
      await pool.query('INSERT INTO shared.schema_migrations (id) VALUES ($1)', [filename]);
    }
    await writeFile(
      statePath,
      JSON.stringify({
        available: true,
        containerId: container.getId(),
        connectionString: container.getConnectionUri(),
      }),
    );
  } catch (error) {
    if (container) await container.stop().catch(() => undefined);
    const requireDocker = process.env.CI === 'true' || process.env.REQUIRE_DOCKER === '1';
    if (requireDocker) throw error;
    console.warn(
      `Skipping PostgreSQL/Testcontainers suites: Docker unavailable (${error.message})`,
    );
    await writeFile(statePath, JSON.stringify({ available: false }));
  } finally {
    if (pool) await pool.end();
  }
};
