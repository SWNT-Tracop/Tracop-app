import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import request from 'supertest';
import { AppModule } from '../src/bootstrap/app.module.js';
import { InMemoryOtpSender } from '../src/modules/identity/adapters/out/otp-senders.js';
import { PhoneNumber } from '../src/modules/identity/domain/phone-number.js';
import { User } from '../src/modules/identity/domain/user.js';
import {
  OTP_SENDER,
  PASSWORDLESS_HASHER,
  TOKEN_SERVICE,
} from '../src/modules/identity/ports/tokens.js';
import { STORAGE_PORT } from '../src/modules/catalog/ports/storage-port.js';
import { InMemoryStorageAdapter } from '../src/modules/catalog/adapters/out/in-memory-storage.adapter.js';
import { DATABASE_POOL } from '../src/shared/infra/tokens.js';
import { createId } from '../src/shared/kernel/ids.js';
import { describePostgres } from './postgres-suite.js';
import { createSyntheticJpeg } from './helpers/synthetic-image.js';
import { findCoordinateExposure } from './helpers/coordinate-exposure.js';

describePostgres('catalog photo HTTP flow (Nest + PostgreSQL Testcontainers)', () => {
  let app: INestApplication;
  let pool: pg.Pool;
  let otpSender: InMemoryOtpSender;
  let storage: InMemoryStorageAdapter;
  let phoneCounter = 8000000;
  const now = new Date();

  const newPhone = () => `301${String(phoneCounter++).padStart(7, '0')}`;
  const actor = (token: string) => ({ Authorization: `Bearer ${token}` });

  const register = async (role: 'producer' | 'buyer') => {
    const phone = newPhone();
    const deviceId = createId();
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        phone,
        role,
        fullName: `Persona ${role}`,
        deviceId,
        platform: 'web',
        consent: { accepted: true, version: 'v0-draft' },
      })
      .expect(201);
    const code = otpSender.sent.at(-1)?.code;
    const verified = await request(app.getHttpServer())
      .post('/auth/otp/verify')
      .send({ phone, deviceId, platform: 'web', code })
      .expect(201);
    return { token: verified.body.accessToken as string, userId: verified.body.user.id as string };
  };

  const createOperator = async (): Promise<string> => {
    const id = createId();
    const deviceId = createId();
    const sessionId = createId();
    const familyId = createId();
    const phoneValue = `+57${newPhone()}`;
    const parsed = PhoneNumber.parse(phoneValue);
    if (!parsed.ok) throw parsed.error;
    const user = User.createStaff(
      {
        id,
        role: 'operator',
        phone: parsed.value,
        fullName: 'Operador sintético',
        locale: 'es-CO',
        createdAt: now,
      },
      now,
    );
    await pool.query(
      `INSERT INTO identity.users (id, role, full_name, phone, status, locale, phone_verified_at, created_at, updated_at)
       VALUES ($1, 'operator', $2, $3, 'active', 'es-CO', $4, $4, $4)`,
      [id, user.props.fullName, phoneValue, now],
    );
    await pool.query(
      `INSERT INTO identity.devices (id, user_id, platform, created_at) VALUES ($1, $2, 'web', $3)`,
      [deviceId, id, now],
    );
    const refreshToken = randomBytes(32).toString('base64url');
    await pool.query(
      `INSERT INTO identity.sessions (id, user_id, device_id, family_id, refresh_hash, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        sessionId,
        id,
        deviceId,
        familyId,
        app.get(PASSWORDLESS_HASHER).hashRefreshToken(refreshToken),
        new Date(now.getTime() + 3_600_000),
        now,
      ],
    );
    return app.get(TOKEN_SERVICE).issueAccessToken(user.props, sessionId, deviceId, now);
  };

  const createPublishedLot = async (
    producerToken: string,
    operatorToken: string,
  ): Promise<string> => {
    const categoryId = createId();
    await request(app.getHttpServer())
      .post('/catalog/categories')
      .set(actor(operatorToken))
      .send({ id: categoryId, name: `Categoría ${categoryId}`, parentId: null })
      .expect(201);
    const productId = createId();
    await request(app.getHttpServer())
      .post('/catalog/products')
      .set(actor(operatorToken))
      .send({ id: productId, categoryId, name: 'Producto sintético', unit: 'kg', attributes: {} })
      .expect(201);
    await request(app.getHttpServer())
      .put('/me/provider-profile')
      .set(actor(producerToken))
      .send({
        displayName: 'Finca sintética',
        municipality: 'Tunja',
        department: 'Boyacá',
        lat: 5.5,
        lng: -73.4,
        description: '',
      })
      .expect(200);
    const lotId = createId();
    await request(app.getHttpServer())
      .post('/lots')
      .set(actor(producerToken))
      .send({
        id: lotId,
        productId,
        quantityMilli: '25000',
        unit: 'kg',
        unitPrice: 3200,
        qualityGrade: 'A',
        availableFrom: now.toISOString(),
        availableUntil: new Date(now.getTime() + 86_400_000).toISOString(),
        locationLat: 5.5,
        locationLng: -73.4,
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/lots/${lotId}/publish`)
      .set(actor(producerToken))
      .send({ version: 1 })
      .expect(201);
    return lotId;
  };

  const prepareUpload = async (token: string, lotId: string, photoId = createId()) => {
    const response = await request(app.getHttpServer())
      .post(`/lots/${lotId}/photos`)
      .set(actor(token))
      .send({ photoId })
      .expect(201);
    return { photoId, response };
  };

  const uploadSyntheticPhoto = async (policy: { fields: Record<string, string> }) => {
    await storage.acceptUpload(
      policy.fields.key!,
      await createSyntheticJpeg({ width: 64, height: 48 }),
      'image/jpeg',
    );
  };

  beforeAll(async () => {
    const sender = new InMemoryOtpSender();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(OTP_SENDER)
      .useValue(sender)
      .compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
    pool = app.get(DATABASE_POOL) as pg.Pool;
    storage = app.get(STORAGE_PORT) as InMemoryStorageAdapter;
    otpSender = sender;
  });

  beforeEach(async () => {
    phoneCounter = 8000000;
    await pool.query(`TRUNCATE catalog.lot_photos, catalog.lots, catalog.products, catalog.categories,
      identity.provider_profiles, identity.consents, identity.otp_codes, identity.sessions, identity.devices,
      identity.channel_links, identity.rate_limit_counters, identity.users, shared.outbox_events CASCADE`);
    otpSender.sent.length = 0;
  });

  afterAll(async () => {
    await app.close();
  });

  it('generates distinct unpredictable upload keys without lot, provider, photo or filename identifiers', async () => {
    const operator = await createOperator();
    const producer = await register('producer');
    const lotId = await createPublishedLot(producer.token, operator);

    const attempts = await Promise.all(
      Array.from({ length: 10 }, () => {
        const photoId = createId();
        return request(app.getHttpServer())
          .post(`/lots/${lotId}/photos`)
          .set(actor(producer.token))
          .send({ photoId, filename: 'private-producer-filename.jpg' })
          .then((response) => ({ photoId, response }));
      }),
    );
    const accepted = attempts.filter(({ response }) => response.status === 201);
    const rejected = attempts.filter(({ response }) => response.status === 409);
    expect(accepted).toHaveLength(5);
    expect(rejected).toHaveLength(5);
    for (const { response } of rejected) expect(response.body.code).toBe('photo_limit');

    const incomingKeys = accepted.map(
      ({ response }) => response.body.uploadPolicy.fields.key as string,
    );
    expect(new Set(incomingKeys).size).toBe(incomingKeys.length);
    for (const { photoId, response } of accepted) {
      const key = response.body.uploadPolicy.fields.key as string;
      expect(key).toMatch(/^incoming\/[A-Za-z0-9_-]{43}$/);
      expect(key).not.toContain(lotId);
      expect(key).not.toContain(producer.userId);
      expect(key).not.toContain(photoId);
      expect(key).not.toContain('private-producer-filename.jpg');
    }

    const first = accepted[0]!;
    const reissued = await request(app.getHttpServer())
      .post(`/lots/${lotId}/photos`)
      .set(actor(producer.token))
      .send({ photoId: first.photoId })
      .expect(201);
    expect(reissued.body.state).toBe('pending');
    expect(reissued.body.uploadPolicy.fields.key).toBe(first.response.body.uploadPolicy.fields.key);
  });

  it('claims concurrent confirmations once and reaches a deterministic ready state', async () => {
    const operator = await createOperator();
    const producer = await register('producer');
    const lotId = await createPublishedLot(producer.token, operator);
    const prepared = await prepareUpload(producer.token, lotId);
    expect(prepared.response.body.uploadPolicy.fields.key).toMatch(/^incoming\//);
    expect(prepared.response.body).not.toHaveProperty('mediaRef');
    expect(prepared.response.body).not.toHaveProperty('objectKey');
    await uploadSyntheticPhoto(prepared.response.body.uploadPolicy);

    const results = await Promise.all([
      request(app.getHttpServer())
        .post(`/lots/${lotId}/photos/${prepared.photoId}/confirm`)
        .set(actor(producer.token)),
      request(app.getHttpServer())
        .post(`/lots/${lotId}/photos/${prepared.photoId}/confirm`)
        .set(actor(producer.token)),
    ]);
    expect(results.map(({ status }) => status)).toEqual([201, 201]);
    for (const result of results) expect(['ready', 'processing']).toContain(result.body.state);
    expect(results.some(({ body }) => body.state === 'ready')).toBe(true);

    await request(app.getHttpServer())
      .post(`/lots/${lotId}/photos/${prepared.photoId}/confirm`)
      .set(actor(producer.token))
      .expect(201)
      .expect(({ body }) => expect(body.state).toBe('ready'));
    const detail = await request(app.getHttpServer())
      .get(`/lots/${lotId}`)
      .set(actor(producer.token))
      .expect(200);
    expect(detail.body.photos).toHaveLength(1);
  });

  it('rejects invalid images with 422, deletes the original immediately and frees quota', async () => {
    const operator = await createOperator();
    const producer = await register('producer');
    const lotId = await createPublishedLot(producer.token, operator);
    const prepared = [];
    for (let index = 0; index < 5; index += 1) {
      prepared.push(await prepareUpload(producer.token, lotId));
    }
    const invalid = prepared[0]!;
    const originalKey = invalid.response.body.uploadPolicy.fields.key as string;
    await storage.acceptUpload(originalKey, Buffer.from('not an image'), 'image/jpeg');

    const rejected = await request(app.getHttpServer())
      .post(`/lots/${lotId}/photos/${invalid.photoId}/confirm`)
      .set(actor(producer.token))
      .expect(422);
    expect(rejected.body.code).toBe('photo_format_invalid');
    await expect(storage.headObject(originalKey)).resolves.toBeNull();

    await request(app.getHttpServer())
      .post(`/lots/${lotId}/photos`)
      .set(actor(producer.token))
      .send({ photoId: createId() })
      .expect(201);
  });

  it('reorders ready photos and exposes only the cover in listings', async () => {
    const operator = await createOperator();
    const producer = await register('producer');
    const buyer = await register('buyer');
    const lotId = await createPublishedLot(producer.token, operator);
    const photos = [];
    for (let index = 0; index < 3; index += 1) {
      const prepared = await prepareUpload(producer.token, lotId);
      await uploadSyntheticPhoto(prepared.response.body.uploadPolicy);
      await request(app.getHttpServer())
        .post(`/lots/${lotId}/photos/${prepared.photoId}/confirm`)
        .set(actor(producer.token))
        .expect(201);
      photos.push(prepared.photoId);
    }

    const listing = await request(app.getHttpServer())
      .get('/lots')
      .set(actor(buyer.token))
      .expect(200);
    const listedLot = listing.body.items.find(({ id }: { id: string }) => id === lotId);
    expect(listedLot.photos).toHaveLength(1);
    expect(listedLot.photos[0].url).toContain('photos/');
    expect(listedLot.photos[0].url).not.toContain('incoming/');
    expect(listedLot.photos[0].url).not.toContain(lotId);
    for (const photo of listedLot.photos) {
      expect(Object.keys(photo).sort()).toEqual(['id', 'position', 'url']);
      expect(photo).not.toHaveProperty('mediaRef');
      expect(photo).not.toHaveProperty('objectKey');
    }
    expect(listedLot).not.toHaveProperty('providerId');
    expect(findCoordinateExposure(listedLot, [{ latitude: 5.5, longitude: -73.4 }])).toEqual([]);

    const before = await request(app.getHttpServer())
      .get(`/lots/${lotId}`)
      .set(actor(buyer.token))
      .expect(200);
    expect(before.body.photos.map(({ position }: { position: number }) => position)).toEqual([
      1, 2, 3,
    ]);
    expect(JSON.stringify(before.body.photos)).not.toContain('incoming/');
    expect(before.body.photos.every(({ url }: { url: string }) => !url.includes(lotId))).toBe(true);
    for (const photo of before.body.photos) {
      expect(Object.keys(photo).sort()).toEqual(['id', 'position', 'url']);
      expect(photo).not.toHaveProperty('mediaRef');
      expect(photo).not.toHaveProperty('objectKey');
    }
    expect(before.body).not.toHaveProperty('providerId');
    expect(findCoordinateExposure(before.body, [{ latitude: 5.5, longitude: -73.4 }])).toEqual([]);

    const reversed = [...photos].reverse();
    await request(app.getHttpServer())
      .patch(`/lots/${lotId}/photos/order`)
      .set(actor(producer.token))
      .send({ photoIds: reversed })
      .expect(200);

    const after = await request(app.getHttpServer())
      .get(`/lots/${lotId}`)
      .set(actor(buyer.token))
      .expect(200);
    expect(after.body.photos.map(({ id }: { id: string }) => id)).toEqual(reversed);
    expect(after.body.photos.map(({ position }: { position: number }) => position)).toEqual([
      1, 2, 3,
    ]);
  });

  it('uses the same generic 409 for a photo id owned by another lot or owner', async () => {
    const operator = await createOperator();
    const first = await register('producer');
    const second = await register('producer');
    const firstLotId = await createPublishedLot(first.token, operator);
    const secondLotId = await createPublishedLot(second.token, operator);
    const prepared = await prepareUpload(first.token, firstLotId);

    const duplicateLot = await request(app.getHttpServer())
      .post('/lots')
      .set(actor(second.token))
      .send({
        id: firstLotId,
        productId: createId(),
        quantityMilli: '25000',
        unit: 'kg',
        unitPrice: 3200,
        qualityGrade: 'A',
        availableFrom: now.toISOString(),
        availableUntil: new Date(now.getTime() + 86_400_000).toISOString(),
        locationLat: 5.5,
        locationLng: -73.4,
      })
      .expect(409);

    await request(app.getHttpServer())
      .post(`/lots/${secondLotId}/photos`)
      .set(actor(first.token))
      .send({ photoId: prepared.photoId })
      .expect(409)
      .expect(({ body }) => expect(body).toEqual(duplicateLot.body));
    await request(app.getHttpServer())
      .post(`/lots/${firstLotId}/photos`)
      .set(actor(second.token))
      .send({ photoId: prepared.photoId })
      .expect(409)
      .expect(({ body }) => expect(body).toEqual(duplicateLot.body));
  });
});
