const { PostgreSqlContainer } = require('@testcontainers/postgresql');
const { readFile, writeFile } = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { Pool } = require('pg');

const statePath = join(tmpdir(), 'tracop-identity-test-container.json');

module.exports = async () => {
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const pool = new Pool({ connectionString: container.getConnectionUri() });
  try {
    for (const filename of [
      '0000_initial-schemas.sql',
      '0001_identity.sql',
      '0002_identity_integrity.sql',
      '0003_identity_device_session_uniqueness.sql',
      '0004_messaging.sql',
    ]) {
      await pool.query(await readFile(resolve('drizzle', filename), 'utf8'));
    }
  } finally {
    await pool.end();
  }
  await writeFile(
    statePath,
    JSON.stringify({
      containerId: container.getId(),
      connectionString: container.getConnectionUri(),
    }),
  );
};
