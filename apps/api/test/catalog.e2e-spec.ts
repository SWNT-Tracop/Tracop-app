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
  PASSWORDLESS_HASHER,
  TOKEN_SERVICE,
  OTP_SENDER,
} from '../src/modules/identity/ports/tokens.js';
import { DATABASE_POOL } from '../src/shared/infra/tokens.js';
import { createId } from '../src/shared/kernel/ids.js';
import { describePostgres } from './postgres-suite.js';

describePostgres('catalog HTTP flow (Nest + PostgreSQL Testcontainers)', () => {
  let app: INestApplication;
  let pool: pg.Pool;
  let otpSender: InMemoryOtpSender;
  let phoneCounter = 7000000;
  const now = new Date();

  const newPhone = () => `300${String(phoneCounter++).padStart(7, '0')}`;
  const actor = (token: string) => ({ Authorization: `Bearer ${token}` });

  const register = async (role: 'producer' | 'buyer') => {
    const phone = newPhone();
    const deviceId = createId();
    const registered = await request(app.getHttpServer())
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
    expect(registered.body.message).toBe('Si el registro puede continuar, recibirás un código.');
    const code = otpSender.sent.at(-1)?.code;
    const verified = await request(app.getHttpServer())
      .post('/auth/otp/verify')
      .send({
        phone,
        deviceId,
        platform: 'web',
        code,
      })
      .expect(201);
    return {
      token: verified.body.accessToken as string,
      userId: verified.body.user.id as string,
      phone: `+57${phone}`,
    };
  };

  const createOperator = async (): Promise<{ token: string; userId: string }> => {
    const id = createId();
    const deviceId = createId();
    const sessionId = createId();
    const familyId = createId();
    const phoneValue = `+57300${String(phoneCounter++).padStart(7, '0')}`;
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
    const hasher = app.get(PASSWORDLESS_HASHER);
    const refreshToken = randomBytes(32).toString('base64url');
    await pool.query(
      `INSERT INTO identity.sessions (id, user_id, device_id, family_id, refresh_hash, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        sessionId,
        id,
        deviceId,
        familyId,
        hasher.hashRefreshToken(refreshToken),
        new Date(now.getTime() + 3_600_000),
        now,
      ],
    );
    const token = await app
      .get(TOKEN_SERVICE)
      .issueAccessToken(user.props, sessionId, deviceId, now);
    return { token, userId: id };
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
    otpSender = sender;
  });

  beforeEach(async () => {
    phoneCounter = 7000000;
    await pool.query(`TRUNCATE catalog.lot_photos, catalog.lots, catalog.products, catalog.categories,
      identity.provider_profiles, identity.consents, identity.otp_codes, identity.sessions, identity.devices,
      identity.channel_links, identity.users, shared.outbox_events CASCADE`);
    otpSender.sent.length = 0;
  });

  afterAll(async () => {
    await app.close();
  });

  it('runs staff taxonomy → provider profile/lot publish → buyer search/get and enforces privacy and negative cases', async () => {
    const operator = await createOperator();
    const producer = await register('producer');
    const buyer = await register('buyer');
    const outsider = await register('producer');

    await request(app.getHttpServer())
      .post('/catalog/categories')
      .set(actor(producer.token))
      .send({ id: createId(), name: 'No autorizado', parentId: null })
      .expect(403);

    const rootId = createId();
    const childId = createId();
    await request(app.getHttpServer())
      .post('/catalog/categories')
      .set(actor(operator.token))
      .send({ id: rootId, name: 'Frutas', parentId: null })
      .expect(201);
    await request(app.getHttpServer())
      .post('/catalog/categories')
      .set(actor(operator.token))
      .send({ id: childId, name: 'Frutas rojas', parentId: rootId })
      .expect(201);
    const productId = createId();
    await request(app.getHttpServer())
      .post('/catalog/products')
      .set(actor(operator.token))
      .send({
        id: productId,
        categoryId: childId,
        name: 'Mora fresca',
        unit: 'kg',
        attributes: { organic: true },
      })
      .expect(201);

    const profile = await request(app.getHttpServer())
      .put('/me/provider-profile')
      .set(actor(producer.token))
      .send({
        displayName: 'Finca La Esperanza',
        municipality: 'Tunja',
        department: 'Boyacá',
        lat: 5.5,
        lng: -73.4,
        description: 'Perfil sintético',
      })
      .expect(200);
    expect(profile.body).toEqual({ status: 'saved' });

    const lotId = createId();
    const lotInput = {
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
    };
    await request(app.getHttpServer())
      .post('/lots')
      .set(actor(producer.token))
      .send(lotInput)
      .expect(201);
    const published = await request(app.getHttpServer())
      .post(`/lots/${lotId}/publish`)
      .set(actor(producer.token))
      .send({ version: 1 })
      .expect(201);
    expect(published.body.status).toBe('published');

    const search = await request(app.getHttpServer())
      .get('/lots')
      .query({
        categoryId: rootId,
        q: 'mora fresca',
        lat: 5.5,
        lng: -73.4,
        radiusKm: 25,
        sort: 'distance',
      })
      .set(actor(buyer.token))
      .expect(200);
    expect(search.body.items).toHaveLength(1);
    const found = search.body.items[0];
    expect(found.id).toBe(lotId);
    expect(Number.isInteger(found.distanceKm)).toBe(true);
    expect(found.distanceKm).toBeGreaterThanOrEqual(1);
    for (const response of [search.body, found]) {
      const serialized = JSON.stringify(response);
      expect(serialized).not.toContain('locationLat');
      expect(serialized).not.toContain('locationLng');
      expect(serialized).not.toContain('providerId');
      expect(serialized).not.toContain(producer.phone);
      expect(serialized).not.toContain('5.5');
      expect(serialized).not.toContain('-73.4');
    }
    await request(app.getHttpServer()).get(`/lots/${lotId}`).set(actor(buyer.token)).expect(200);
    const ownerView = await request(app.getHttpServer())
      .get(`/lots/${lotId}`)
      .set(actor(producer.token))
      .expect(200);
    expect(ownerView.body.locationLat).toBe(5.5);
    expect(ownerView.body.locationLng).toBe(-73.4);

    const secondLotId = createId();
    const secondLot = {
      ...lotInput,
      id: secondLotId,
      locationLat: 5.52,
    };
    await request(app.getHttpServer())
      .post('/lots')
      .set(actor(producer.token))
      .send(secondLot)
      .expect(201);
    await request(app.getHttpServer())
      .post(`/lots/${secondLotId}/publish`)
      .set(actor(producer.token))
      .send({ version: 1 })
      .expect(201);
    const firstDistancePage = await request(app.getHttpServer())
      .get('/lots')
      .query({ limit: 1, sort: 'distance', lat: 5.5, lng: -73.4, radiusKm: 25 })
      .set(actor(buyer.token))
      .expect(200);
    expect(firstDistancePage.body.nextCursor).toEqual(expect.any(String));
    expect(firstDistancePage.body.nextCursor).not.toContain('5.52');
    expect(firstDistancePage.body.nextCursor).not.toContain('-73.4');
    const secondDistancePage = await request(app.getHttpServer())
      .get('/lots')
      .query({
        limit: 1,
        sort: 'distance',
        lat: 5.5,
        lng: -73.4,
        radiusKm: 25,
        cursor: firstDistancePage.body.nextCursor,
      })
      .set(actor(buyer.token))
      .expect(200);
    expect(secondDistancePage.body.items).toHaveLength(1);
    expect(secondDistancePage.body.items[0].id).not.toBe(firstDistancePage.body.items[0].id);

    const draftId = createId();
    await request(app.getHttpServer())
      .post('/lots')
      .set(actor(producer.token))
      .send({ ...lotInput, id: draftId })
      .expect(201);
    await request(app.getHttpServer())
      .get(`/lots/${draftId}`)
      .set(actor(outsider.token))
      .expect(404);
    await request(app.getHttpServer()).get(`/lots/${draftId}`).set(actor(buyer.token)).expect(404);

    const foreignId = createId();
    const outsiderProfile = await request(app.getHttpServer())
      .put('/me/provider-profile')
      .set(actor(outsider.token))
      .send({
        displayName: 'Finca ajena',
        municipality: 'Sogamoso',
        department: 'Boyacá',
        lat: 5.7,
        lng: -72.9,
        description: '',
      })
      .expect(200);
    expect(outsiderProfile.body.status).toBe('saved');
    await request(app.getHttpServer())
      .post('/lots')
      .set(actor(outsider.token))
      .send({ ...lotInput, id: foreignId })
      .expect(201);

    const conflictFromStaleVersion = await request(app.getHttpServer())
      .post(`/lots/${lotId}/cancel`)
      .set(actor(producer.token))
      .send({ version: 1 })
      .expect(409);
    const conflictFromForeignId = await request(app.getHttpServer())
      .post('/lots')
      .set(actor(outsider.token))
      .send(lotInput)
      .expect(409);
    expect(conflictFromForeignId.body).toEqual(conflictFromStaleVersion.body);
  });
});
