import { Test } from '@nestjs/testing';
import type { INestApplicationContext } from '@nestjs/common';
import pg from 'pg';
import { AppModule } from '../src/bootstrap/app.module.js';
import { CatalogService } from '../src/modules/catalog/application/catalog-service.js';
import {
  PROVIDER_PROFILE_SERVICE,
  type ProviderProfileService,
} from '../src/modules/identity/index.js';
import { createId } from '../src/shared/kernel/ids.js';
import { DATABASE_POOL } from '../src/shared/infra/tokens.js';
import { APP_CLOCK } from '../src/shared/infra/tokens.js';
import { describePostgres } from './postgres-suite.js';

describePostgres('catalog repositories and use cases (shared PostgreSQL Testcontainers)', () => {
  let app: INestApplicationContext;
  let pool: pg.Pool;
  let catalog: CatalogService;
  let profiles: ProviderProfileService;
  const now = new Date('2026-10-30T12:00:00.000Z');
  const staff = { sub: '00000000-0000-7000-8000-000000000001', role: 'operator' };
  const producer = { sub: '00000000-0000-7000-8000-000000000002', role: 'producer' };
  const buyer = { sub: '00000000-0000-7000-8000-000000000003', role: 'buyer' };
  let rootCategoryId: string;
  let childCategoryId: string;
  let productId: string;
  let otherProductId: string;

  const resetTables = async () => {
    await pool.query(`TRUNCATE catalog.lot_photos, catalog.lots, catalog.products, catalog.categories,
      identity.provider_profiles, identity.consents, identity.otp_codes, identity.sessions,
      identity.devices, identity.channel_links, identity.users, shared.outbox_events CASCADE`);
  };

  const createLot = async (
    options: {
      productId?: string;
      price?: bigint;
      lat?: number;
      lng?: number;
      from?: Date;
      until?: Date;
      providerId?: string;
      publish?: boolean;
    } = {},
  ) => {
    const ownerId = options.providerId ?? producer.sub;
    const owner = { sub: ownerId, role: 'producer' };
    const input = {
      id: createId(),
      productId: options.productId ?? productId,
      quantityMilli: 10_000n,
      unit: 'kg' as const,
      unitPrice: options.price ?? 1000n,
      qualityGrade: null,
      availableFrom: options.from ?? now,
      availableUntil: options.until ?? new Date(now.getTime() + 86_400_000),
      locationLat: options.lat ?? 5.5,
      locationLng: options.lng ?? -73.4,
    };
    const created = await catalog.createLot(owner, input);
    if (options.publish !== false) return catalog.publishLot(owner, created.id, 1);
    return created;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_CLOCK)
      .useValue({ now: () => new Date(now) })
      .compile();
    app = moduleRef;
    await moduleRef.init();
    pool = app.get(DATABASE_POOL) as pg.Pool;
    catalog = app.get(CatalogService);
    profiles = app.get(PROVIDER_PROFILE_SERVICE) as ProviderProfileService;
  });

  beforeEach(async () => {
    await resetTables();
    for (const [index, item] of [
      [1, staff],
      [2, producer],
      [3, buyer],
      [4, { sub: '00000000-0000-7000-8000-000000000004', role: 'producer' }],
    ] as const) {
      await pool.query(
        `INSERT INTO identity.users (id, role, full_name, phone, status, locale, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'active', 'es-CO', $5, $5)`,
        [
          item.sub,
          item.role,
          `Synthetic ${index}`,
          `+5730000000${String(index).padStart(2, '0')}`,
          now,
        ],
      );
    }
    await profiles.upsertProviderProfile(producer.sub, {
      displayName: 'Finca de Boyacá',
      municipality: 'Tunja',
      department: 'Boyacá',
      lat: 5.5,
      lng: -73.4,
      description: 'Dato sintético',
    });
    await profiles.upsertProviderProfile('00000000-0000-7000-8000-000000000004', {
      displayName: 'Finca secundaria',
      municipality: 'Duitama',
      department: 'Boyacá',
      lat: 5.8,
      lng: -73.0,
      description: 'Dato sintético',
    });
    rootCategoryId = createId();
    childCategoryId = createId();
    await catalog.createCategory(staff, { id: rootCategoryId, name: 'Frutas', parentId: null });
    await catalog.createCategory(staff, {
      id: childCategoryId,
      name: 'Frutas rojas',
      parentId: rootCategoryId,
    });
    productId = createId();
    otherProductId = createId();
    await catalog.createProduct(staff, {
      id: productId,
      categoryId: childCategoryId,
      name: 'Mora azul',
      unit: 'kg',
      attributes: { organic: true },
    });
    await catalog.createProduct(staff, {
      id: otherProductId,
      categoryId: rootCategoryId,
      name: 'Papa criolla',
      unit: 'kg',
      attributes: {},
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('applies category descendants, product, accent-insensitive token text, COP price, date and distance filters', async () => {
    const matching = await createLot({ price: 2500n, lat: 5.51, lng: -73.4 });
    await createLot({ productId: otherProductId, price: 2500n, lat: 5.51, lng: -73.4 });
    await createLot({ price: 500n, lat: 6.5, lng: -73.4 });

    const result = await catalog.searchVisibleLots({
      limit: 20,
      sort: 'price',
      categoryId: rootCategoryId,
      productId,
      q: 'MÓRA azu',
      minPrice: 2000,
      maxPrice: 3000,
      availableFrom: now,
      availableUntil: new Date(now.getTime() + 3_600_000),
      lat: 5.5,
      lng: -73.4,
      radiusKm: 10,
    });
    expect(result.items.map(({ lot }) => lot.id)).toEqual([matching.id]);
  });

  it.each(['price', 'distance', 'availability', 'recent'] as const)(
    'does stable keyset pagination with tie-break ids for %s order',
    async (sort) => {
      const first = await createLot({
        price: 1000n,
        lat: 5.5,
        from: new Date(now.getTime() + 60_000),
      });
      const second = await createLot({
        price: 1000n,
        lat: 5.5,
        from: new Date(now.getTime() + 60_000),
      });
      await createLot({ price: 2000n, lat: 5.51, from: new Date(now.getTime() + 120_000) });
      const criteria = {
        limit: 1,
        sort,
        ...(sort === 'distance' ? { lat: 5.5, lng: -73.4, radiusKm: 30 } : {}),
      } as const;
      const page1 = await catalog.searchVisibleLots(criteria);
      expect(page1.items).toHaveLength(1);
      expect(page1.nextCursor).toBeDefined();
      const page2 = await catalog.searchVisibleLots({
        ...criteria,
        cursor: page1.nextCursor!,
        limit: 2,
      });
      expect(page2.items.map(({ lot }) => lot.id)).not.toContain(page1.items[0]!.lot.id);
      if (sort !== 'recent') {
        expect(new Set([first.id, second.id])).toContain(page1.items[0]!.lot.id);
      }
    },
  );

  it('uses inclusive distance boundaries and excludes only availability_until earlier than now', async () => {
    const exact = await createLot({ lat: 5.5, lng: -73.4, until: now });
    await createLot({
      lat: 5.5,
      lng: -73.4,
      from: new Date(now.getTime() - 2),
      until: new Date(now.getTime() - 1),
    });
    const edge = await createLot({ lat: 5.5 + (10 / 6371.0088) * (180 / Math.PI), lng: -73.4 });
    const outside = await createLot({
      lat: 5.5 + (10 / 6371.0088) * (180 / Math.PI) + 0.00001,
      lng: -73.4,
    });
    const inRadius = await catalog.searchVisibleLots({
      limit: 20,
      sort: 'distance',
      lat: 5.5,
      lng: -73.4,
      radiusKm: 10,
    });
    expect(inRadius.items.map(({ lot }) => lot.id)).toContain(exact.id);
    expect(inRadius.items.map(({ lot }) => lot.id)).toContain(edge.id);
    expect(inRadius.items.map(({ lot }) => lot.id)).not.toContain(outside.id);
    expect(inRadius.items.some(({ lot }) => lot.availableUntil.getTime() < now.getTime())).toBe(
      false,
    );
  });

  it('enforces migration CHECKs and unique indexes in PostgreSQL', async () => {
    await expect(
      pool.query(
        `INSERT INTO catalog.categories (id, name, depth, created_at, updated_at) VALUES ($1, 'x', 4, $2, $2)`,
        [createId(), now],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query(
        `INSERT INTO catalog.categories (id, name, parent_id, depth, created_at, updated_at)
       VALUES ($1, 'Self', $1, 1, $2, $2)`,
        [createId(), now],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query(
        `INSERT INTO catalog.categories (id, name, depth, created_at, updated_at) VALUES ($1, '   ', 1, $2, $2)`,
        [createId(), now],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query(
        `INSERT INTO catalog.categories (id, name, depth, created_at, updated_at) VALUES ($1, 'Frutas', 1, $2, $2)`,
        [createId(), now],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      pool.query(
        `INSERT INTO catalog.products (id, category_id, name, search_text, unit, created_at, updated_at)
       VALUES ($1, $2, 'Producto malo', 'producto malo', 'litros', $3, $3)`,
        [createId(), rootCategoryId, now],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query(
        `INSERT INTO catalog.products (id, category_id, name, search_text, unit, attributes, created_at, updated_at)
       VALUES ($1, $2, 'JSON inválido', 'json invalido', 'kg', '[]'::jsonb, $3, $3)`,
        [createId(), rootCategoryId, now],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query(
        `INSERT INTO catalog.products (id, category_id, name, search_text, unit, created_at, updated_at)
       VALUES ($1, $2, 'Papa criolla', 'papa criolla', 'kg', $3, $3)`,
        [createId(), rootCategoryId, now],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    const invalidLots = [
      {
        quantity: 0,
        unit: 'kg',
        price: 1000,
        quality: null,
        from: now,
        until: now,
        lat: 5.5,
        lng: -73.4,
        status: 'draft',
        version: 1,
      },
      {
        quantity: 1,
        unit: 'kg',
        price: 0,
        quality: null,
        from: now,
        until: now,
        lat: 5.5,
        lng: -73.4,
        status: 'draft',
        version: 1,
      },
      {
        quantity: 1,
        unit: 'litros',
        price: 1000,
        quality: null,
        from: now,
        until: now,
        lat: 5.5,
        lng: -73.4,
        status: 'draft',
        version: 1,
      },
      {
        quantity: 1,
        unit: 'kg',
        price: 1000,
        quality: 'x'.repeat(101),
        from: now,
        until: now,
        lat: 5.5,
        lng: -73.4,
        status: 'draft',
        version: 1,
      },
      {
        quantity: 1,
        unit: 'kg',
        price: 1000,
        quality: null,
        from: new Date(now.getTime() + 1),
        until: now,
        lat: 5.5,
        lng: -73.4,
        status: 'draft',
        version: 1,
      },
      {
        quantity: 1,
        unit: 'kg',
        price: 1000,
        quality: null,
        from: now,
        until: now,
        lat: 14,
        lng: -73.4,
        status: 'draft',
        version: 1,
      },
      {
        quantity: 1,
        unit: 'kg',
        price: 1000,
        quality: null,
        from: now,
        until: now,
        lat: 5.5,
        lng: -60,
        status: 'draft',
        version: 1,
      },
      {
        quantity: 1,
        unit: 'kg',
        price: 1000,
        quality: null,
        from: now,
        until: now,
        lat: 5.5,
        lng: -73.4,
        status: 'invalid',
        version: 1,
      },
      {
        quantity: 1,
        unit: 'kg',
        price: 1000,
        quality: null,
        from: now,
        until: now,
        lat: 5.5,
        lng: -73.4,
        status: 'draft',
        version: 0,
      },
    ];
    for (const invalid of invalidLots) {
      await expect(
        pool.query(
          `INSERT INTO catalog.lots (id, provider_id, product_id, quantity, unit, unit_price, quality_grade,
         available_from, available_until, location_lat, location_lng, status, version, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14)`,
          [
            createId(),
            producer.sub,
            productId,
            invalid.quantity,
            invalid.unit,
            invalid.price,
            invalid.quality,
            invalid.from,
            invalid.until,
            invalid.lat,
            invalid.lng,
            invalid.status,
            invalid.version,
            now,
          ],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    }
  });

  it('deduplicates concurrent same-id creation, CAS-updates one of two edits, and writes one publish event', async () => {
    const input = {
      id: createId(),
      productId,
      quantityMilli: 10_000n,
      unit: 'kg' as const,
      unitPrice: 1000n,
      qualityGrade: null,
      availableFrom: now,
      availableUntil: new Date(now.getTime() + 86_400_000),
      locationLat: 5.5,
      locationLng: -73.4,
    };
    const [createdA, createdB] = await Promise.all([
      catalog.createLot(producer, input),
      catalog.createLot(producer, input),
    ]);
    expect(createdA.id).toBe(createdB.id);
    const edits = await Promise.allSettled([
      catalog.updateLot(producer, input.id, 1, { quantityMilli: 11_000n }),
      catalog.updateLot(producer, input.id, 1, { quantityMilli: 12_000n }),
    ]);
    expect(edits.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(edits.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const updated = (await catalog.getMyLots(producer))[0]!;
    const publications = await Promise.allSettled([
      catalog.publishLot(producer, input.id, updated.version),
      catalog.publishLot(producer, input.id, updated.version),
    ]);
    expect(publications.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(publications.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const eventCount = await pool.query<{ count: string }>(
      `SELECT count(*) FROM shared.outbox_events WHERE type = 'LotPublished' AND aggregate = $1`,
      [`lot:${input.id}`],
    );
    expect(Number(eventCount.rows[0]?.count)).toBe(1);
    const stored = await pool.query<{ count: string }>(
      'SELECT count(*) FROM catalog.lots WHERE id = $1',
      [input.id],
    );
    expect(Number(stored.rows[0]?.count)).toBe(1);
  });

  it('prints the query plan for the primary visible-lots PostgreSQL query', async () => {
    await createLot();
    const plan = await pool.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN (COSTS OFF) SELECT id, product_id, provider_id, unit_price, available_from, available_until,
       location_lat, location_lng FROM catalog.lots
       WHERE status = 'published' AND available_until >= $1 AND deleted_at IS NULL
       AND location_lat BETWEEN $2 AND $3 AND location_lng BETWEEN $4 AND $5
       ORDER BY available_from, id LIMIT 21`,
      [now, 5.4, 5.6, -73.5, -73.3],
    );
    const output = plan.rows.map((row) => row['QUERY PLAN']).join('\n');
    process.stdout.write(`\nCatalog visible-lots EXPLAIN:\n${output}\n`);
    expect(output).toMatch(/(Seq Scan|Index Scan|Bitmap Heap Scan)/);
  });
});
