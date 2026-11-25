import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import pg from 'pg';
import { AppModule } from '../src/bootstrap/app.module.js';
import { configureHttp } from '../src/bootstrap/http.js';
import { CatalogService } from '../src/modules/catalog/index.js';
import {
  PROVIDER_PROFILE_SERVICE,
  type ProviderProfileService,
} from '../src/modules/identity/index.js';
import { OrderingService } from '../src/modules/ordering/index.js';
import { InMemoryOtpSender } from '../src/modules/identity/adapters/out/otp-senders.js';
import { PhoneNumber } from '../src/modules/identity/domain/phone-number.js';
import { User } from '../src/modules/identity/domain/user.js';
import {
  OTP_SENDER,
  PASSWORDLESS_HASHER,
  TOKEN_SERVICE,
} from '../src/modules/identity/ports/tokens.js';
import { DATABASE_POOL } from '../src/shared/infra/tokens.js';
import { createId } from '../src/shared/kernel/ids.js';
import { findCoordinateExposure } from './helpers/coordinate-exposure.js';
import { describePostgres, resetPostgresFixtures } from './postgres-suite.js';

type Account = { readonly token: string; readonly userId: string; readonly role: string };

describePostgres('Logistics HTTP and sync (Nest + PostgreSQL Testcontainers)', () => {
  let app: INestApplication;
  let pool: pg.Pool;
  let otpSender: InMemoryOtpSender;
  let catalog: CatalogService;
  let ordering: OrderingService;
  let profiles: ProviderProfileService;
  let carrier: Account;
  let otherCarrier: Account;
  let buyer: Account;
  let producer: Account;
  let operator: Account;
  let orderId: string;
  const coordinates = [{ latitude: 5.5, longitude: -73.4 }];
  let phoneSequence = 1;

  const nextPhone = (): string => `302${String(phoneSequence++).padStart(7, '0')}`;

  const createAccount = async (role: 'carrier' | 'buyer' | 'producer' | 'operator') => {
    const phone = nextPhone();
    const deviceId = createId();
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        phone,
        role,
        fullName: `Sintético ${role}`,
        deviceId,
        platform: 'web',
        consent: { accepted: true, version: 'v0-draft' },
      })
      .expect(201);
    const session = await request(app.getHttpServer())
      .post('/auth/otp/verify')
      .send({ phone, deviceId, platform: 'web', code: otpSender.sent.at(-1)?.code })
      .expect(201);
    return {
      token: session.body.accessToken as string,
      userId: session.body.user.id as string,
      role,
    };
  };

  const auth = (account: Account) => `Bearer ${account.token}`;
  const actor = (account: Account) => ({ sub: account.userId, role: account.role });

  const createOperator = async (): Promise<Account> => {
    const id = createId();
    const deviceId = createId();
    const sessionId = createId();
    const familyId = createId();
    const now = new Date();
    const phoneValue = `+57303${String(phoneSequence++).padStart(7, '0')}`;
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
        (
          app.get(PASSWORDLESS_HASHER) as { hashRefreshToken(token: string): string }
        ).hashRefreshToken(refreshToken),
        new Date(now.getTime() + 3_600_000),
        now,
      ],
    );
    const token = await (
      app.get(TOKEN_SERVICE) as {
        issueAccessToken(
          user: unknown,
          sessionId: string,
          deviceId: string,
          now: Date,
        ): Promise<string>;
      }
    ).issueAccessToken(user.props, sessionId, deviceId, now);
    return { token, userId: id, role: 'operator' };
  };

  beforeAll(async () => {
    const sender = new InMemoryOtpSender();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(OTP_SENDER)
      .useValue(sender)
      .compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    configureHttp(app, 256 * 1024);
    await app.listen(0, '127.0.0.1');
    pool = app.get(DATABASE_POOL) as pg.Pool;
    await resetPostgresFixtures(pool);
    otpSender = sender;
    catalog = app.get(CatalogService);
    ordering = app.get(OrderingService);
    profiles = app.get(PROVIDER_PROFILE_SERVICE) as ProviderProfileService;

    carrier = await createAccount('carrier');
    otherCarrier = await createAccount('carrier');
    buyer = await createAccount('buyer');
    producer = await createAccount('producer');
    operator = await createOperator();

    await profiles.upsertProviderProfile(producer.userId, {
      displayName: 'Finca sintética',
      municipality: 'Tunja',
      department: 'Boyacá',
      lat: coordinates[0]!.latitude,
      lng: coordinates[0]!.longitude,
      description: 'Perfil de prueba',
    });

    const staff = { sub: createId(), role: 'operator' };
    const categoryId = createId();
    await catalog.createCategory(staff, { id: categoryId, name: 'Hortalizas', parentId: null });
    const productId = createId();
    await catalog.createProduct(staff, {
      id: productId,
      categoryId,
      name: 'Tomate sintético',
      unit: 'kg',
      attributes: {},
    });
    const lotId = createId();
    await catalog.createLot(actor(producer), {
      id: lotId,
      productId,
      quantityMilli: 100_000n,
      unit: 'kg',
      unitPrice: 5_000n,
      qualityGrade: null,
      availableFrom: new Date(Date.now() - 86_400_000),
      availableUntil: new Date(Date.now() + 10 * 86_400_000),
      locationLat: coordinates[0]!.latitude,
      locationLng: coordinates[0]!.longitude,
    });
    await catalog.publishLot(actor(producer), lotId, 1);

    const created = await ordering.createOrder(actor(buyer), {
      id: createId(),
      buyerId: buyer.userId,
      lines: [{ lotId, quantityMilli: 1_000n }],
      deliveryAddress: 'Carrera 7 # 1, Bogotá',
      deliveryWindow: null,
    });
    orderId = created.order.id;
    await ordering.acceptQuote({
      actor: actor(buyer),
      orderId,
      expectedVersion: created.order.version,
    });
    // El módulo de pagos aún no implementa la verificación; se simula el estado pagado.
    await pool.query(
      `UPDATE ordering.orders SET status = 'paid', version = version + 1, updated_at = now()
       WHERE id = $1`,
      [orderId],
    );

    await request(app.getHttpServer())
      .post('/sync/push')
      .set('Authorization', auth(carrier))
      .send({
        operations: [
          {
            opId: createId(),
            entity: 'carrier_profile',
            entityId: carrier.userId,
            type: 'create',
            payload: { vehicleType: 'Camion', capacityKg: 2000, plate: 'ABC123' },
          },
        ],
      })
      .expect(201)
      .expect(({ body }) => expect(body.results[0]).toMatchObject({ status: 'applied' }));
  });

  afterAll(async () => {
    await app?.close();
  });

  it('rechaza roles ajenos y expone solo zonas textuales', async () => {
    await request(app.getHttpServer())
      .post('/logistics/carrier-profile')
      .set('Authorization', auth(buyer))
      .send({ vehicleType: 'Camion', capacityKg: 2000, plate: 'XYZ999' })
      .expect(403);
    await request(app.getHttpServer())
      .get('/logistics/trips')
      .set('Authorization', auth(carrier))
      .expect(403);
    await request(app.getHttpServer())
      .get('/logistics/carriers')
      .set('Authorization', auth(carrier))
      .expect(403);

    const recommendation = await request(app.getHttpServer())
      .post('/logistics/trips/recommend')
      .set('Authorization', auth(carrier))
      .expect(200);
    expect(recommendation.body).toEqual([
      { orderId, kind: 'pickup', sequence: 1, zone: 'tunja' },
      { orderId, kind: 'delivery', sequence: 2, zone: 'bogotá' },
    ]);
    expect(findCoordinateExposure(recommendation.body, coordinates)).toEqual([]);
    const candidates = await request(app.getHttpServer())
      .get('/logistics/orders/candidates')
      .set('Authorization', auth(carrier))
      .expect(200);
    expect(candidates.body).toMatchObject([
      {
        orderId,
        status: 'paid',
        deliveryZone: 'bogotá',
        pickupZones: ['tunja'],
        lines: [{ lotId: expect.any(String), quantityMilli: '1000', unit: 'kg' }],
      },
    ]);
    expect(candidates.body[0]).not.toHaveProperty('deliveryAddress');
    expect(candidates.body[0]).not.toHaveProperty('buyerId');
    expect(candidates.body[0]).not.toHaveProperty('providerId');
    expect(findCoordinateExposure(candidates.body, coordinates)).toEqual([]);
    await request(app.getHttpServer())
      .get('/logistics/orders/candidates')
      .set('Authorization', auth(buyer))
      .expect(403);
    expect(
      await request(app.getHttpServer())
        .get('/logistics/conflicts')
        .set('Authorization', auth(operator))
        .expect(200),
    ).toMatchObject({
      body: { orderIds: [] },
    });
  });

  it('crea un viaje, registra check-in HTTP y sincroniza la entrega', async () => {
    const tripId = createId();
    const created = await request(app.getHttpServer())
      .post('/sync/push')
      .set('Authorization', auth(carrier))
      .send({
        operations: [
          {
            opId: tripId,
            entity: 'trip',
            entityId: tripId,
            type: 'create',
            payload: { orderIds: [orderId] },
          },
        ],
      })
      .expect(201);
    expect(created.body.results[0]).toMatchObject({ status: 'applied', serverVersion: 2 });
    const createdTrip = await request(app.getHttpServer())
      .get(`/logistics/trips/${tripId}`)
      .set('Authorization', auth(carrier))
      .expect(200);
    expect(createdTrip.body).toMatchObject({ status: 'assigned', version: 2 });
    const startOperationId = createId();
    const started = await request(app.getHttpServer())
      .post('/sync/push')
      .set('Authorization', auth(carrier))
      .send({
        operations: [
          {
            opId: startOperationId,
            entity: 'trip',
            entityId: tripId,
            type: 'transition',
            payload: { action: 'start' },
            baseVersion: createdTrip.body.version,
          },
        ],
      })
      .expect(201);
    expect(started.body.results[0]).toMatchObject({ status: 'applied', serverVersion: 3 });
    const tripVersion = started.body.results[0].serverVersion as number;
    expect(findCoordinateExposure(created.body, coordinates)).toEqual([]);

    const stopsResponse = await request(app.getHttpServer())
      .get(`/logistics/trips/${tripId}/stops`)
      .set('Authorization', auth(carrier))
      .expect(200);
    const pickup = stopsResponse.body.find((stop: { kind: string }) => stop.kind === 'pickup') as {
      id: string;
    };
    const delivery = stopsResponse.body.find(
      (stop: { kind: string }) => stop.kind === 'delivery',
    ) as { id: string };
    expect(stopsResponse.body).toHaveLength(2);
    expect(findCoordinateExposure(stopsResponse.body, coordinates)).toEqual([]);

    const incidentId = createId();
    const incidentPush = await request(app.getHttpServer())
      .post('/sync/push')
      .set('Authorization', auth(carrier))
      .send({
        operations: [
          {
            opId: incidentId,
            entity: 'incident',
            entityId: incidentId,
            type: 'create',
            payload: {
              orderId,
              tripId,
              type: 'retraso',
              description: 'Demora sintética',
            },
          },
        ],
      })
      .expect(201);
    expect(incidentPush.body.results[0]).toMatchObject({ status: 'applied' });
    const incidents = await request(app.getHttpServer())
      .get('/logistics/incidents')
      .set('Authorization', auth(carrier))
      .expect(200);
    const incident = incidents.body.find((item: { id: string }) => item.id === incidentId);
    expect(incident.tripId).toBe(tripId);
    await request(app.getHttpServer())
      .get('/logistics/incidents')
      .set('Authorization', auth(otherCarrier))
      .expect(200)
      .expect(({ body }) => expect(body).toEqual([]));
    await request(app.getHttpServer())
      .get('/logistics/incidents')
      .set('Authorization', auth(operator))
      .expect(200)
      .expect(({ body }) =>
        expect(body.map((item: { id: string }) => item.id)).toContain(incidentId),
      );
    await request(app.getHttpServer())
      .post(`/logistics/incidents/${incidentId}/resolve`)
      .set('Authorization', auth(otherCarrier))
      .expect(404);

    const checkin = await request(app.getHttpServer())
      .post(`/logistics/stops/${pickup.id}/checkins`)
      .set('Authorization', auth(carrier))
      .send({
        id: createId(),
        kind: 'pickup',
        clientAt: new Date().toISOString(),
        mediaRef: 'evidence/pickup',
      })
      .expect(201);
    expect(checkin.body).toMatchObject({ kind: 'pickup', orderId, tripId });
    expect(findCoordinateExposure(checkin.body, coordinates)).toEqual([]);

    const pushed = await request(app.getHttpServer())
      .post('/sync/push')
      .set('Authorization', auth(carrier))
      .send({
        operations: [
          {
            opId: createId(),
            entity: 'checkin',
            entityId: createId(),
            type: 'create',
            payload: { stopId: delivery.id, kind: 'delivery', clientAt: new Date().toISOString() },
            baseVersion: tripVersion,
          },
        ],
      })
      .expect(201);
    expect(pushed.body.results[0]).toMatchObject({ status: 'applied' });

    const trip = await request(app.getHttpServer())
      .get(`/logistics/trips/${tripId}`)
      .set('Authorization', auth(carrier))
      .expect(200);
    expect(trip.body.status).toBe('completed');
    expect(findCoordinateExposure(trip.body, coordinates)).toEqual([]);

    const pulled = await request(app.getHttpServer())
      .get('/sync/pull?cursor=0&limit=500')
      .set('Authorization', auth(carrier))
      .expect(200);
    const changes = pulled.body.changes as readonly {
      entity: string;
      payload: Record<string, unknown>;
    }[];
    expect(changes.some((change) => change.entity === 'checkin')).toBe(true);
    expect(changes.some((change) => change.entity === 'trip')).toBe(true);
    expect(findCoordinateExposure(changes, coordinates)).toEqual([]);

    const duplicate = await request(app.getHttpServer())
      .post('/sync/push')
      .set('Authorization', auth(carrier))
      .send({
        operations: [
          {
            opId: createId(),
            entity: 'checkin',
            entityId: createId(),
            type: 'create',
            payload: { stopId: delivery.id, kind: 'delivery', clientAt: new Date().toISOString() },
            baseVersion: tripVersion,
          },
        ],
      })
      .expect(201);
    expect(duplicate.body.results[0]).toMatchObject({ status: 'conflict' });
  });
});
