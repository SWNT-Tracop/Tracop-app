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
import { APP_ENVIRONMENT, DATABASE_POOL } from '../src/shared/infra/tokens.js';
import { APP_CLOCK } from '../src/shared/infra/tokens.js';
import { loadAppEnvironment } from '../src/shared/infra/env.js';
import { DatabaseService } from '../src/shared/infra/database.js';
import { describePostgres } from './postgres-suite.js';
import { SyncService } from '../src/modules/sync/index.js';

describePostgres('catalog repositories and use cases (shared PostgreSQL Testcontainers)', () => {
  let app: INestApplicationContext;
  let pool: pg.Pool;
  let catalog: CatalogService;
  let profiles: ProviderProfileService;
  let sync: SyncService;
  let database: DatabaseService;
  const now = new Date('2026-10-30T12:00:00.000Z');
  const staff = { sub: '00000000-0000-7000-8000-000000000001', role: 'operator' };
  const producer = { sub: '00000000-0000-7000-8000-000000000002', role: 'producer' };
  const buyer = { sub: '00000000-0000-7000-8000-000000000003', role: 'buyer' };
  let rootCategoryId: string;
  let childCategoryId: string;
  let productId: string;
  let otherProductId: string;

  const resetTables = async () => {
    await pool.query(`TRUNCATE sync.processed_operations, sync.change_log,
      catalog.lot_reservations, catalog.lot_photos, catalog.lots, catalog.products, catalog.categories,
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
      .overrideProvider(APP_ENVIRONMENT)
      .useValue({
        ...loadAppEnvironment(),
        SYNC_PULL_RATE_LIMIT: 10_000,
        SYNC_PUSH_RATE_LIMIT: 10_000,
      })
      .overrideProvider(APP_CLOCK)
      .useValue({ now: () => new Date(now) })
      .compile();
    app = moduleRef;
    await moduleRef.init();
    pool = app.get(DATABASE_POOL) as pg.Pool;
    catalog = app.get(CatalogService);
    profiles = app.get(PROVIDER_PROFILE_SERVICE) as ProviderProfileService;
    sync = app.get(SyncService);
    database = app.get(DatabaseService);
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

  it('rolls back the catalog mutation and change_log row together and releases the sequence lock', async () => {
    const id = createId();
    await expect(
      database.transaction(async () => {
        await catalog.createLot(producer, {
          id,
          productId,
          quantityMilli: 10_000n,
          unit: 'kg',
          unitPrice: 1_000n,
          qualityGrade: null,
          availableFrom: now,
          availableUntil: new Date(now.getTime() + 86_400_000),
          locationLat: 5.5,
          locationLng: -73.4,
        });
        throw new Error('force rollback after change recorder insert');
      }),
    ).rejects.toThrow('force rollback after change recorder insert');

    const [catalogRow, changeRow] = await Promise.all([
      pool.query('SELECT 1 FROM catalog.lots WHERE id = $1', [id]),
      pool.query("SELECT 1 FROM sync.change_log WHERE entity = 'lot' AND entity_id = $1", [id]),
    ]);
    expect(catalogRow.rowCount).toBe(0);
    expect(changeRow.rowCount).toBe(0);

    const committed = await catalog.createLot(producer, {
      id: createId(),
      productId,
      quantityMilli: 10_000n,
      unit: 'kg',
      unitPrice: 1_000n,
      qualityGrade: null,
      availableFrom: now,
      availableUntil: new Date(now.getTime() + 86_400_000),
      locationLat: 5.5,
      locationLng: -73.4,
    });
    expect(committed.status).toBe('draft');
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

  it('backfills pre-existing catalog rows with reusable payload builders and skips them on rerun', async () => {
    const existingDraft = await createLot({ publish: false });
    const existingPublished = await createLot();
    await pool.query('TRUNCATE sync.change_log');

    const first = await catalog.backfillChanges();
    const lotRows = await pool.query(
      `SELECT op, owner_user_id, payload FROM sync.change_log WHERE entity = 'lot' AND entity_id = $1`,
      [existingDraft.id],
    );
    const publishedRow = await pool.query(
      `SELECT op, owner_user_id, payload FROM sync.change_log WHERE entity = 'lot' AND entity_id = $1`,
      [existingPublished.id],
    );
    const second = await catalog.backfillChanges();

    expect(lotRows.rows).toHaveLength(1);
    expect(lotRows.rows[0]).toMatchObject({
      op: 'upsert',
      owner_user_id: producer.sub,
      payload: { id: existingDraft.id, version: 1, status: 'draft' },
    });
    expect(publishedRow.rows).toHaveLength(1);
    expect(publishedRow.rows[0]).toMatchObject({
      op: 'upsert',
      owner_user_id: producer.sub,
      payload: { id: existingPublished.id, version: 2, status: 'published' },
    });
    expect(first.recorded).toBeGreaterThan(0);
    expect(second).toEqual({ recorded: 0, skipped: first.recorded });
  });

  it('soft-deletes a draft and its photos atomically while publishing a tombstone', async () => {
    const draft = await createLot({ publish: false });
    const photoId = createId();
    await pool.query(
      `INSERT INTO catalog.lot_photos (id, lot_id, media_ref, created_at, state, position, expires_at)
       VALUES ($1, $2, 'photos/synthetic-delete.webp', $3, 'pending', 1, $4)`,
      [photoId, draft.id, now, new Date(now.getTime() + 86_400_000)],
    );

    const deleted = await catalog.deleteLot(producer, draft.id, draft.version);
    const rows = await pool.query(
      `SELECT p.deleted_at AS photo_deleted_at, l.deleted_at AS lot_deleted_at
       FROM catalog.lot_photos p JOIN catalog.lots l ON l.id = p.lot_id WHERE p.id = $1`,
      [photoId],
    );
    const tombstone = await pool.query(
      `SELECT payload FROM sync.change_log WHERE entity = 'lot' AND entity_id = $1 AND op = 'delete'`,
      [draft.id],
    );
    expect(deleted.version).toBe(draft.version + 1);
    expect(rows.rows[0].photo_deleted_at).toBeInstanceOf(Date);
    expect(rows.rows[0].lot_deleted_at).toBeInstanceOf(Date);
    expect(tombstone.rows[0].payload).toEqual({
      id: draft.id,
      version: deleted.version,
      tombstone: true,
    });
  });

  it('applies create, edit, edit, publish versions in one ordered push and shares changes across two devices', async () => {
    const lotId = createId();
    const create = {
      opId: createId(),
      entity: 'lot',
      entityId: lotId,
      type: 'create' as const,
      payload: {
        id: lotId,
        productId,
        quantityMilli: '10000',
        unit: 'kg',
        unitPrice: 1000,
        qualityGrade: null,
        availableFrom: now.toISOString(),
        availableUntil: new Date(now.getTime() + 86_400_000).toISOString(),
        locationLat: 5.5,
        locationLng: -73.4,
      },
    };
    const updateOne = {
      opId: createId(),
      entity: 'lot',
      entityId: lotId,
      type: 'update' as const,
      baseVersion: 1,
      payload: { unitPrice: 1200 },
    };
    const updateTwo = {
      opId: createId(),
      entity: 'lot',
      entityId: lotId,
      type: 'update' as const,
      baseVersion: 2,
      payload: { quantityMilli: '12000' },
    };
    const publish = {
      opId: createId(),
      entity: 'lot',
      entityId: lotId,
      type: 'transition' as const,
      baseVersion: 3,
      payload: { status: 'published' },
    };

    const applied = await sync.push({ ...producer, did: createId() }, [
      create,
      updateOne,
      updateTwo,
      publish,
    ]);
    expect(applied.results.map((result) => [result.status, result.serverVersion])).toEqual([
      ['applied', 1],
      ['applied', 2],
      ['applied', 3],
      ['applied', 4],
    ]);
    const deviceA = await sync.pull({ ...producer, did: createId() }, '0', 20);
    const deviceB = await sync.pull({ ...producer, did: createId() }, '0', 20);
    const anotherProvider = await sync.pull(
      { sub: '00000000-0000-7000-8000-000000000004', role: 'producer', did: createId() },
      '0',
      20,
    );
    expect(
      deviceA.changes
        .filter((change) => change.entityId === lotId)
        .map((change) => change.payload.version),
    ).toEqual([1, 2, 3, 4]);
    expect(deviceB.changes).toEqual(deviceA.changes);
    expect(anotherProvider.changes.filter((change) => change.entityId === lotId)).toEqual([]);
  });

  it('rejects dependent operations deterministically after an intermediate version conflict', async () => {
    const lot = await createLot({ publish: false });
    const failedEdit = {
      opId: createId(),
      entity: 'lot',
      entityId: lot.id,
      type: 'update' as const,
      baseVersion: 9,
      payload: { unitPrice: 2000 },
    };
    const dependentEdit = {
      opId: createId(),
      entity: 'lot',
      entityId: lot.id,
      type: 'update' as const,
      baseVersion: 1,
      payload: { unitPrice: 2200 },
    };
    const result = await sync.push({ ...producer, did: createId() }, [failedEdit, dependentEdit]);
    expect(result.results.map(({ status, code }) => [status, code])).toEqual([
      ['conflict', 'version_conflict'],
      ['rejected', 'dependency_failed'],
    ]);
  });

  it.each(['reserved', 'sold_out', 'expired'] as const)(
    'rejects client-requested %s transitions with a typed code',
    async (status) => {
      const lot = await createLot({ publish: false });
      const response = await sync.push({ ...producer, did: createId() }, [
        {
          opId: createId(),
          entity: 'lot',
          entityId: lot.id,
          type: 'transition',
          baseVersion: 1,
          payload: { status },
        },
      ]);
      expect(response.results[0]).toMatchObject({
        status: 'rejected',
        code: 'unsupported_transition',
      });
    },
  );

  it('serializes concurrent duplicate opIds and hides stored results from a different user', async () => {
    const lotId = createId();
    const operation = {
      opId: createId(),
      entity: 'lot',
      entityId: lotId,
      type: 'create' as const,
      payload: {
        id: lotId,
        productId,
        quantityMilli: '10000',
        unit: 'kg',
        unitPrice: 1000,
        qualityGrade: null,
        availableFrom: now.toISOString(),
        availableUntil: new Date(now.getTime() + 86_400_000).toISOString(),
        locationLat: 5.5,
        locationLng: -73.4,
      },
    };
    const duplicateResults = await Promise.all([
      sync.push({ ...producer, did: createId() }, [operation]),
      sync.push({ ...producer, did: createId() }, [operation]),
    ]);
    expect(duplicateResults[0]).toEqual(duplicateResults[1]);

    const otherUserResult = await sync.push(
      { sub: '00000000-0000-7000-8000-000000000004', role: 'producer', did: createId() },
      [operation],
    );
    expect(otherUserResult.results[0]).toEqual({ opId: operation.opId, status: 'rejected' });
  });

  it('does not deadlock concurrent REST and sync writes to the same lot', async () => {
    const lotId = createId();
    const input = {
      id: lotId,
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
    const operation = {
      opId: createId(),
      entity: 'lot',
      entityId: lotId,
      type: 'create' as const,
      payload: {
        ...input,
        quantityMilli: input.quantityMilli.toString(),
        unitPrice: Number(input.unitPrice),
        availableFrom: input.availableFrom.toISOString(),
        availableUntil: input.availableUntil.toISOString(),
      },
    };
    const mixed = await Promise.allSettled([
      catalog.createLot(producer, input),
      sync.push({ ...producer, did: createId() }, [operation]),
    ]);
    expect(mixed.every((result) => result.status === 'fulfilled')).toBe(true);
    const stored = await pool.query(
      'SELECT count(*)::int AS count FROM catalog.lots WHERE id = $1',
      [lotId],
    );
    expect(stored.rows[0].count).toBe(1);
  });

  it('does not stop draining when writers finish during an in-flight empty pull', async () => {
    let writersFinished = false;
    let releaseFirstPull!: (page: { changes: readonly unknown[]; hasMore: boolean }) => void;
    let pullCount = 0;
    const firstPull = new Promise<{ changes: readonly unknown[]; hasMore: boolean }>((resolve) => {
      releaseFirstPull = resolve;
    });
    const readUntilFinished = async (): Promise<void> => {
      for (;;) {
        const writersWereFinishedBeforePull = writersFinished;
        const page = pullCount++ === 0 ? await firstPull : { changes: [], hasMore: false };
        if (writersWereFinishedBeforePull && !page.hasMore && page.changes.length === 0) return;
      }
    };

    const reader = readUntilFinished();
    writersFinished = true;
    releaseFirstPull({ changes: [], hasMore: false });
    await reader;
    expect(pullCount).toBe(2);
  });

  it.each(Array.from({ length: 20 }, (_, index) => index + 1))(
    'stress run %i: 8 concurrent REST/sync writers and a paginating pull reader have no gaps or duplicates',
    async () => {
      await pool.query('TRUNCATE sync.change_log');
      const stressActor = { sub: createId(), role: 'producer' };
      const deviceIds = Array.from({ length: 4 }, () => createId());
      const operationId = () => createId();
      const makeInput = (id: string) => ({
        id,
        productId,
        quantityMilli: 10_000n,
        unit: 'kg' as const,
        unitPrice: 1_000n,
        qualityGrade: null,
        availableFrom: now,
        availableUntil: new Date(now.getTime() + 86_400_000),
        locationLat: 5.5,
        locationLng: -73.4,
      });
      const makeSyncOperation = (id: string) => {
        const input = makeInput(id);
        return {
          opId: operationId(),
          entity: 'lot',
          entityId: id,
          type: 'create' as const,
          payload: {
            ...input,
            quantityMilli: input.quantityMilli.toString(),
            unitPrice: Number(input.unitPrice),
            availableFrom: input.availableFrom.toISOString(),
            availableUntil: input.availableUntil.toISOString(),
          },
        };
      };

      const committedEntityIds: string[] = [];
      const restWriters = Array.from({ length: 4 }, async () => {
        const inputs = Array.from({ length: 25 }, () => makeInput(createId()));
        committedEntityIds.push(...inputs.map(({ id }) => id));
        const results = await Promise.all(
          inputs.map((input) => catalog.createLot(stressActor, input)),
        );
        expect(results.every((lot) => lot.status === 'draft')).toBe(true);
      });
      const syncWriters = Array.from({ length: 4 }, async (_, index) => {
        const operations = Array.from({ length: 25 }, () => makeSyncOperation(createId()));
        committedEntityIds.push(...operations.map(({ entityId }) => entityId));
        const result = await sync.push({ ...stressActor, did: deviceIds[index]! }, operations);
        expect(result.results.every(({ status }) => status === 'applied')).toBe(true);
      });
      const writers = [...restWriters, ...syncWriters];
      let writersFinished = false;
      const writerCompletion = Promise.all(writers).finally(() => {
        writersFinished = true;
      });

      const received: Array<{ serverSeq: string; entityId: string }> = [];
      let cursor = '0';
      const readUntilWritersFinish = async (): Promise<void> => {
        for (;;) {
          const writersWereFinishedBeforePull = writersFinished;
          const page = await sync.pull({ ...stressActor, did: createId() }, cursor, 17);
          received.push(
            ...page.changes.map(({ serverSeq, entityId }) => ({ serverSeq, entityId })),
          );
          cursor = page.nextCursor;
          if (writersWereFinishedBeforePull && !page.hasMore && page.changes.length === 0) return;
          if (!writersFinished && !page.hasMore && page.changes.length === 0) {
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
        }
      };
      await Promise.all([writerCompletion, readUntilWritersFinish()]);

      const committedRows = await pool.query<{ server_seq: string; entity_id: string }>(
        `SELECT server_seq::text, entity_id::text FROM sync.change_log
         WHERE entity = 'lot' AND owner_user_id = $1 ORDER BY server_seq`,
        [stressActor.sub],
      );
      const expectedIds = committedRows.rows.map(({ entity_id }) => entity_id);
      const receivedIds = received.map(({ entityId }) => entityId);
      const receivedSeqs = received.map(({ serverSeq }) => BigInt(serverSeq));
      const finalDrain: Array<{ serverSeq: string; entityId: string }> = [];
      let drainCursor = '0';
      for (;;) {
        const page = await sync.pull({ ...stressActor, did: createId() }, drainCursor, 37);
        finalDrain.push(
          ...page.changes.map(({ serverSeq, entityId }) => ({ serverSeq, entityId })),
        );
        drainCursor = page.nextCursor;
        if (!page.hasMore) break;
      }
      const finalDrainIds = new Set(finalDrain.map(({ entityId }) => entityId));
      const missingIds = expectedIds.filter((id) => !receivedIds.includes(id));
      const missingRows = committedRows.rows
        .filter(({ entity_id }) => missingIds.includes(entity_id))
        .map(({ server_seq, entity_id }) => ({
          entityId: entity_id,
          serverSeq: server_seq,
          inChangeLog: true,
          inCompletePull: finalDrainIds.has(entity_id),
          paginatedCursorPassedSeq: BigInt(cursor) >= BigInt(server_seq),
        }));
      expect(committedRows.rows).toHaveLength(200);
      expect([...committedEntityIds].sort()).toEqual([...expectedIds].sort());
      if ([...receivedIds].sort().join(',') !== [...expectedIds].sort().join(',')) {
        throw new Error(
          JSON.stringify({
            paginatedCursor: cursor,
            missingRows,
            completePullCount: finalDrain.length,
            completePullCursor: drainCursor,
            taxonomyRows: finalDrain.filter(({ entityId }) => !expectedIds.includes(entityId)),
          }),
        );
      }
      expect(finalDrainIds.size).toBe(200);
      expect(new Set(receivedIds).size).toBe(receivedIds.length);
      expect(new Set(receivedSeqs.map(String)).size).toBe(receivedSeqs.length);
      expect(receivedSeqs).toEqual(
        [...receivedSeqs].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
      );
    },
  );

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
      `EXPLAIN (COSTS OFF) SELECT l.id, l.product_id, l.provider_id, l.unit_price, l.available_from, l.available_until,
       l.location_lat, l.location_lng,
       ((l.quantity * 1000 - COALESCE((SELECT SUM(r.quantity_milli) FROM catalog.lot_reservations r
         WHERE r.lot_id = l.id AND r.status = 'active' AND r.expires_at >= $1), 0)) * 1000) AS available_milli
       FROM catalog.lots l
       WHERE l.status IN ('published', 'reserved') AND l.available_until >= $1 AND l.deleted_at IS NULL
       AND l.quantity * 1000 > COALESCE((SELECT SUM(r.quantity_milli) FROM catalog.lot_reservations r
         WHERE r.lot_id = l.id AND r.status = 'active' AND r.expires_at >= $1), 0)
       AND l.location_lat BETWEEN $2 AND $3 AND l.location_lng BETWEEN $4 AND $5
       ORDER BY l.available_from, l.id LIMIT 21`,
      [now, 5.4, 5.6, -73.5, -73.3],
    );
    const output = plan.rows.map((row) => row['QUERY PLAN']).join('\n');
    process.stdout.write(`\nCatalog visible-lots EXPLAIN:\n${output}\n`);
    expect(output).toMatch(/(Seq Scan|Index Scan|Bitmap Heap Scan)/);
    expect(output).toContain('lot_reservations');
  });

  it('reserves under lot lock and materializes published/reserved transitions with recorder', async () => {
    const lot = await createLot();
    const orderId = createId();
    const exp = new Date(now.getTime() + 60_000);
    await catalog.reserveLots({
      orderId,
      lines: [{ lotId: lot.id, quantityMilli: 9_000n }],
      expiresAt: exp,
    });
    expect((await catalog.getLotQuote(lot.id)).availableQuantityMilli).toBe(1_000n);
    expect(
      (await pool.query('SELECT status, version FROM catalog.lots WHERE id = $1', [lot.id]))
        .rows[0],
    ).toMatchObject({ status: 'published', version: 2 });
    const otherOrderId = createId();
    await catalog.reserveLots({
      orderId: otherOrderId,
      lines: [{ lotId: lot.id, quantityMilli: 1_000n }],
      expiresAt: exp,
    });
    expect(
      (await pool.query('SELECT status, version FROM catalog.lots WHERE id = $1', [lot.id]))
        .rows[0],
    ).toMatchObject({ status: 'reserved', version: 3 });
    await catalog.releaseOrderReservations(otherOrderId);
    expect(
      (await pool.query('SELECT status, version FROM catalog.lots WHERE id = $1', [lot.id]))
        .rows[0],
    ).toMatchObject({ status: 'published', version: 4 });
  });
});
