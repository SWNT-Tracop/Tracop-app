import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import pg from 'pg';
import { AppModule } from '../src/bootstrap/app.module.js';
import { configureHttp } from '../src/bootstrap/http.js';
import { APP_ENVIRONMENT, DATABASE_POOL } from '../src/shared/infra/tokens.js';
import { loadAppEnvironment } from '../src/shared/infra/env.js';
import { CatalogService } from '../src/modules/catalog/index.js';
import {
  PROVIDER_PROFILE_SERVICE,
  type ProviderProfileService,
} from '../src/modules/identity/index.js';
import { OTP_SENDER } from '../src/modules/identity/ports/tokens.js';
import { InMemoryOtpSender } from '../src/modules/identity/adapters/out/otp-senders.js';
import { createId } from '../src/shared/kernel/ids.js';
import { findCoordinateExposure } from './helpers/coordinate-exposure.js';
import { describePostgres, resetPostgresFixtures } from './postgres-suite.js';

describePostgres('sync authenticated HTTP (Nest + PostgreSQL Testcontainers)', () => {
  let app: INestApplication;
  let pool: pg.Pool;
  let catalog: CatalogService;
  let profiles: ProviderProfileService;
  let otpSender: InMemoryOtpSender;
  let phoneSequence = 1;
  let productId: string;
  let owner: { phone: string; deviceId: string; token: string; userId: string };
  let secondDevice: { deviceId: string; token: string };
  let thirdUser: { phone: string; deviceId: string; token: string; userId: string };

  const nextPhone = (): string => `301${String(phoneSequence++).padStart(7, '0')}`;
  const createAccount = async (phone = nextPhone(), deviceId = randomUUID()) => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        phone,
        role: 'producer',
        fullName: 'Productor sintético',
        deviceId,
        platform: 'web',
        consent: { accepted: true, version: 'v0-draft' },
      })
      .expect(201);
    const code = otpSender.sent.at(-1)?.code;
    const session = await request(app.getHttpServer())
      .post('/auth/otp/verify')
      .send({ phone, deviceId, platform: 'web', code })
      .expect(201);
    return {
      phone,
      deviceId,
      token: session.body.accessToken as string,
      userId: session.body.user.id as string,
    };
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_ENVIRONMENT)
      .useValue({
        ...loadAppEnvironment(),
        SYNC_PUSH_MAX_BODY_BYTES: 256 * 1024,
        SYNC_PUSH_RATE_LIMIT: 30,
        SYNC_PULL_RATE_LIMIT: 120,
        SYNC_RATE_WINDOW_SECONDS: 60,
      })
      .compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    configureHttp(app, 256 * 1024);
    await app.listen(0, '127.0.0.1');
    pool = app.get(DATABASE_POOL) as pg.Pool;
    await resetPostgresFixtures(pool);
    otpSender = app.get(OTP_SENDER) as InMemoryOtpSender;
    catalog = app.get(CatalogService);
    profiles = app.get(PROVIDER_PROFILE_SERVICE) as ProviderProfileService;

    owner = await createAccount();
    const secondDeviceId = randomUUID();
    await pool.query('TRUNCATE identity.rate_limit_counters');
    await request(app.getHttpServer())
      .post('/auth/otp/request')
      .send({ phone: owner.phone })
      .expect(201);
    const secondSession = await request(app.getHttpServer())
      .post('/auth/otp/verify')
      .send({
        phone: owner.phone,
        deviceId: secondDeviceId,
        platform: 'web',
        code: otpSender.sent.at(-1)?.code,
      })
      .expect(201);
    secondDevice = { deviceId: secondDeviceId, token: secondSession.body.accessToken as string };
    thirdUser = await createAccount();
    await profiles.upsertProviderProfile(owner.userId, {
      displayName: 'Finca sintética',
      municipality: 'Tunja',
      department: 'Boyacá',
      lat: 5.5,
      lng: -73.4,
      description: 'Perfil de prueba',
    });

    const staff = { sub: createId(), role: 'operator' };
    const categoryId = createId();
    await catalog.createCategory(staff, { id: categoryId, name: 'Hortalizas', parentId: null });
    productId = createId();
    await catalog.createProduct(staff, {
      id: productId,
      categoryId,
      name: 'Tomate sintético',
      unit: 'kg',
      attributes: {},
    });
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE sync.processed_operations, sync.change_log, catalog.lot_photos, catalog.lots`,
    );
    await catalog.backfillChanges();
  });

  afterAll(async () => {
    await app?.close();
  });

  const lotId = (): string => createId();
  const createLotOperation = (id: string, opId = createId()) => ({
    opId,
    entity: 'lot',
    entityId: id,
    type: 'create',
    payload: {
      id,
      productId,
      quantityMilli: '10000',
      unit: 'kg',
      unitPrice: 2400,
      qualityGrade: null,
      availableFrom: new Date().toISOString(),
      availableUntil: new Date(Date.now() + 86_400_000).toISOString(),
      locationLat: 5.5,
      locationLng: -73.4,
    },
  });

  it('pushes and pulls over HTTP using authenticated user/device claims across two devices', async () => {
    const id = lotId();
    const creation = createLotOperation(id);
    const pushed = await request(app.getHttpServer())
      .post('/sync/push')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ operations: [creation] })
      .expect(201);
    expect(pushed.body.results[0]).toMatchObject({ status: 'applied', serverVersion: 1 });

    const edited = await request(app.getHttpServer())
      .post('/sync/push')
      .set('Authorization', `Bearer ${secondDevice.token}`)
      .send({
        operations: [
          {
            opId: createId(),
            entity: 'lot',
            entityId: id,
            type: 'update',
            baseVersion: 1,
            payload: { unitPrice: 2600 },
          },
        ],
      })
      .expect(201);
    expect(edited.body.results[0]).toMatchObject({ status: 'applied', serverVersion: 2 });

    const published = await request(app.getHttpServer())
      .post('/sync/push')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        operations: [
          {
            opId: createId(),
            entity: 'lot',
            entityId: id,
            type: 'transition',
            baseVersion: 2,
            payload: { status: 'published' },
          },
        ],
      })
      .expect(201);
    expect(published.body.results[0]).toMatchObject({ status: 'applied', serverVersion: 3 });
    const cancelled = await request(app.getHttpServer())
      .post('/sync/push')
      .set('Authorization', `Bearer ${secondDevice.token}`)
      .send({
        operations: [
          {
            opId: createId(),
            entity: 'lot',
            entityId: id,
            type: 'transition',
            baseVersion: 3,
            payload: { status: 'cancelled' },
          },
        ],
      })
      .expect(201);
    expect(cancelled.body.results[0]).toMatchObject({ status: 'applied', serverVersion: 4 });

    const [ownerPull, secondDevicePull] = await Promise.all([
      request(app.getHttpServer())
        .get('/sync/pull?cursor=0&limit=100')
        .set('Authorization', `Bearer ${owner.token}`)
        .expect(200),
      request(app.getHttpServer())
        .get('/sync/pull?cursor=0&limit=100')
        .set('Authorization', `Bearer ${secondDevice.token}`)
        .expect(200),
    ]);
    expect(
      ownerPull.body.changes.filter((change: { entityId: string }) => change.entityId === id),
    ).toHaveLength(4);
    expect(secondDevicePull.body.changes).toEqual(ownerPull.body.changes);

    const operations = await pool.query(
      `SELECT user_id, device_id, entity_id FROM sync.processed_operations
       WHERE entity_id = $1 ORDER BY processed_at`,
      [id],
    );
    expect(operations.rows).toEqual([
      { user_id: owner.userId, device_id: owner.deviceId, entity_id: id },
      { user_id: owner.userId, device_id: secondDevice.deviceId, entity_id: id },
      { user_id: owner.userId, device_id: owner.deviceId, entity_id: id },
      { user_id: owner.userId, device_id: secondDevice.deviceId, entity_id: id },
    ]);

    const attemptedSpoof = await request(app.getHttpServer())
      .post('/sync/push')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ deviceId: thirdUser.deviceId, operations: [createLotOperation(lotId())] })
      .expect(400);
    expect(attemptedSpoof.body).toBeDefined();
  });

  it('rejects missing authentication and never returns another user’s lots or tombstones', async () => {
    await request(app.getHttpServer()).get('/sync/pull').expect(401);
    await request(app.getHttpServer()).post('/sync/push').send({ operations: [] }).expect(401);

    const id = lotId();
    await request(app.getHttpServer())
      .post('/sync/push')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ operations: [createLotOperation(id)] })
      .expect(201);
    const deleted = await request(app.getHttpServer())
      .post('/sync/push')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        operations: [
          {
            opId: createId(),
            entity: 'lot',
            entityId: id,
            type: 'delete',
            baseVersion: 1,
            payload: {},
          },
        ],
      })
      .expect(201);
    expect(deleted.body.results[0]).toMatchObject({ status: 'applied', serverVersion: 2 });

    const outsider = await request(app.getHttpServer())
      .get('/sync/pull?cursor=0&limit=100')
      .set('Authorization', `Bearer ${thirdUser.token}`)
      .expect(200);
    expect(
      outsider.body.changes.some((change: { entityId: string }) => change.entityId === id),
    ).toBe(false);
    expect(findCoordinateExposure(outsider.body, [{ latitude: 5.5, longitude: -73.4 }])).toEqual(
      [],
    );
    expect(
      outsider.body.changes.every((change: { entity: string }) => change.entity !== 'lot'),
    ).toBe(true);
  });

  it('accepts exactly 50 operations and rejects 51', async () => {
    const operations = Array.from({ length: 50 }, (_, index) => ({
      opId: createId(),
      entity: `unknown-${index}`,
      entityId: createId(),
      type: 'create',
      payload: {},
    }));
    const accepted = await request(app.getHttpServer())
      .post('/sync/push')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ operations })
      .expect(201);
    expect(accepted.body.results).toHaveLength(50);
    await request(app.getHttpServer())
      .post('/sync/push')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ operations: [...operations, { ...operations[0], opId: createId() }] })
      .expect(400);
  });

  it('accepts a valid body at exactly 256 KiB and rejects the next byte', async () => {
    const operations = Array.from({ length: 50 }, (_, index) => ({
      opId: createId(),
      entity: `unknown-${index}`,
      entityId: createId(),
      type: 'create',
      payload: { padding: '' },
    }));
    const body = { operations };
    const targetBytes = 256 * 1024;
    const baseLength = Buffer.byteLength(JSON.stringify(body));
    operations.at(-1)!.payload.padding = 'x'.repeat(targetBytes - baseLength);
    const exact = JSON.stringify(body);
    expect(Buffer.byteLength(exact)).toBe(targetBytes);
    await request(app.getHttpServer())
      .post('/sync/push')
      .set('Authorization', `Bearer ${owner.token}`)
      .set('Content-Type', 'application/json')
      .send(exact)
      .expect(201);

    operations.at(-1)!.payload.padding += 'x';
    await request(app.getHttpServer())
      .post('/sync/push')
      .set('Authorization', `Bearer ${owner.token}`)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(body))
      .expect(413);
  });

  it('enforces the per-user push rate limit with HTTP 429', async () => {
    for (let index = 0; index < 30; index += 1) {
      const response = await request(app.getHttpServer())
        .post('/sync/push')
        .set('Authorization', `Bearer ${thirdUser.token}`)
        .send({
          operations: [
            {
              opId: createId(),
              entity: `rate-limit-${index}`,
              entityId: createId(),
              type: 'create',
              payload: {},
            },
          ],
        });
      expect(response.status).toBe(201);
    }
    await request(app.getHttpServer())
      .post('/sync/push')
      .set('Authorization', `Bearer ${thirdUser.token}`)
      .send({
        operations: [
          {
            opId: createId(),
            entity: 'rate-limit-overflow',
            entityId: createId(),
            type: 'create',
            payload: {},
          },
        ],
      })
      .expect(429);
  });

  it('keeps the global 64 KiB limit for non-sync routes', async () => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ phone: nextPhone(), payload: 'x'.repeat(70 * 1024) }))
      .expect(413);
  });
});
