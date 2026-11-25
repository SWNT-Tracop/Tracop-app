const { PostgreSqlContainer } = require('@testcontainers/postgresql');
const { readFile, readdir, writeFile } = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { createHash } = require('node:crypto');
const { Pool } = require('pg');

const worktreeId = createHash('sha256').update(resolve(__dirname, '..')).digest('hex').slice(0, 12);
const statePath = join(tmpdir(), `tracop-${worktreeId}-test-container.json`);

// A product curated before proposals existed must survive every later migration as approved.
const LEGACY_PRODUCT_BEFORE = '0011_product_proposals.sql';
const LEGACY_CATEGORY_ID = '0190f47a-8b45-7cc2-9a1e-000000000011';
const LEGACY_PRODUCT_ID = '0190f47a-8b45-7cc2-9a1e-000000000012';
const LEGACY_TIMESTAMP = '2026-01-01T00:00:00.000Z';

async function insertLegacyProduct(pool) {
  await pool.query(
    `INSERT INTO catalog.categories (id, name, parent_id, depth, created_at, updated_at)
     VALUES ($1, 'Synthetic legacy category', NULL, 1, $2, $2)`,
    [LEGACY_CATEGORY_ID, LEGACY_TIMESTAMP],
  );
  await pool.query(
    `INSERT INTO catalog.products (id, category_id, name, search_text, unit, attributes, created_at, updated_at)
     VALUES ($1, $2, 'Synthetic legacy product', 'synthetic legacy product', 'kg', '{}', $3, $3)`,
    [LEGACY_PRODUCT_ID, LEGACY_CATEGORY_ID, LEGACY_TIMESTAMP],
  );
}

async function verifyAndRemoveLegacyProduct(pool) {
  const { rows } = await pool.query(
    `SELECT status, proposed_by, reviewed_by FROM catalog.products WHERE id = $1`,
    [LEGACY_PRODUCT_ID],
  );
  const row = rows[0];
  if (!row || row.status !== 'approved' || row.proposed_by !== null || row.reviewed_by !== null) {
    throw new Error('Product migrations must keep pre-existing products approved and unreviewed.');
  }
  await pool.query('DELETE FROM catalog.products WHERE id = $1', [LEGACY_PRODUCT_ID]);
  await pool.query('DELETE FROM catalog.categories WHERE id = $1', [LEGACY_CATEGORY_ID]);
  console.log('Verified product migrations keep pre-existing products approved.');
}

module.exports = async () => {
  let container;
  try {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
  } catch (error) {
    const requireDocker = process.env.CI === 'true' || process.env.REQUIRE_DOCKER === '1';
    if (requireDocker) throw error;
    console.warn(
      `Skipping PostgreSQL/Testcontainers suites: Docker unavailable (${error.message})`,
    );
    await writeFile(statePath, JSON.stringify({ available: false }));
    return;
  }

  const pool = new Pool({ connectionString: container.getConnectionUri() });
  try {
    await pool.query('CREATE SCHEMA IF NOT EXISTS shared');
    await pool.query(`CREATE TABLE IF NOT EXISTS shared.schema_migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    // Same discovery as drizzle/migrate.ts so a new migration can never be skipped by tests.
    const migrationFiles = (await readdir(resolve('drizzle')))
      .filter((filename) => /^\d+.*\.sql$/.test(filename))
      .sort();
    for (const filename of migrationFiles) {
      if (filename === LEGACY_PRODUCT_BEFORE) await insertLegacyProduct(pool);
      if (filename === '0006_lot_photos.sql') {
        const timestamp = new Date();
        await pool.query(
          `INSERT INTO catalog.categories (id, name, parent_id, depth, created_at, updated_at)
           VALUES ('0190f47a-8b45-7cc2-9a1e-000000000001', 'Synthetic migration fixture', NULL, 1, $1, $1)`,
          [timestamp],
        );
        await pool.query(
          `INSERT INTO catalog.products (id, category_id, name, search_text, unit, attributes, created_at, updated_at)
           VALUES ('0190f47a-8b45-7cc2-9a1e-000000000002', '0190f47a-8b45-7cc2-9a1e-000000000001',
                   'Synthetic migration product', 'synthetic migration product', 'kg', '{}', $1, $1)`,
          [timestamp],
        );
        await pool.query(
          `INSERT INTO catalog.lots
           (id, provider_id, product_id, quantity, unit, unit_price, available_from, available_until,
            location_lat, location_lng, status, version, created_at, updated_at)
           VALUES ('0190f47a-8b45-7cc2-9a1e-000000000003', '0190f47a-8b45-7cc2-9a1e-000000000004',
                   '0190f47a-8b45-7cc2-9a1e-000000000002', 1, 'kg', 1, $1, $1, 5, -73, 'draft', 1, $1, $1)`,
          [timestamp],
        );
        await pool.query(
          `INSERT INTO catalog.lot_photos (id, lot_id, media_ref, created_at)
           VALUES ('0190f47a-8b45-7cc2-9a1e-000000000005', '0190f47a-8b45-7cc2-9a1e-000000000003',
                   'incoming/legacy-photo', $1)`,
          [timestamp],
        );
      }
      await pool.query(await readFile(resolve('drizzle', filename), 'utf8'));
      await pool.query('INSERT INTO shared.schema_migrations (id) VALUES ($1)', [filename]);
      if (filename === '0006_lot_photos.sql') {
        const backfill = await pool.query(
          `SELECT expires_at < now() AS expired FROM catalog.lot_photos
           WHERE id = '0190f47a-8b45-7cc2-9a1e-000000000005'`,
        );
        if (backfill.rows[0]?.expired !== true) {
          throw new Error('Migration 0006 must backfill legacy photos as expired.');
        }
        await pool.query(
          `DELETE FROM catalog.lot_photos WHERE id = '0190f47a-8b45-7cc2-9a1e-000000000005'`,
        );
        await pool.query(
          `DELETE FROM catalog.lots WHERE id = '0190f47a-8b45-7cc2-9a1e-000000000003'`,
        );
        await pool.query(
          `DELETE FROM catalog.products WHERE id = '0190f47a-8b45-7cc2-9a1e-000000000002'`,
        );
        await pool.query(
          `DELETE FROM catalog.categories WHERE id = '0190f47a-8b45-7cc2-9a1e-000000000001'`,
        );
        console.log('Verified migration 0006 expires pre-existing lot photos.');
      }
    }
    await verifyAndRemoveLegacyProduct(pool);
    await writeFile(
      statePath,
      JSON.stringify({
        available: true,
        containerId: container.getId(),
        connectionString: container.getConnectionUri(),
      }),
    );
  } catch (error) {
    await container.stop().catch(() => undefined);
    throw error;
  } finally {
    await pool.end();
  }
};
