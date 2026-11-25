import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Module, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type pg from 'pg';
import request from 'supertest';
import { APPLICATION_MODULES } from '../src/bootstrap/app.module.js';
import { InMemoryOtpSender } from '../src/modules/identity/adapters/out/otp-senders.js';
import { OTP_SENDER } from '../src/modules/identity/ports/tokens.js';
import { NOTIFICATIONS_OUTBOX_SUBSCRIBER } from '../src/modules/notifications/index.js';
import { PAYMENTS_OUTBOX_SUBSCRIBER } from '../src/modules/payments/index.js';
import { InMemoryStorageAdapter } from '../src/shared/infra/storage/in-memory-storage.adapter.js';
import { PostgresOutboxDispatcher } from '../src/shared/infra/outbox-dispatcher.js';
import { DATABASE_POOL } from '../src/shared/infra/tokens.js';
import { createId } from '../src/shared/kernel/ids.js';
import {
  OUTBOX_DISPATCHER,
  OUTBOX_DISPATCHER_SETTINGS,
  type OutboxDispatcher,
} from '../src/shared/ports/outbox-dispatcher.js';
import {
  OUTBOX_SUBSCRIBERS,
  type OutboxSubscriberPort,
} from '../src/shared/ports/outbox-subscriber.js';
import { STORAGE_PORT } from '../src/shared/ports/storage.js';
import { formatMarkdown } from './helpers/markdown.js';
import { createStaffAccount } from './helpers/staff-account.js';
import { createSyntheticJpeg } from './helpers/synthetic-image.js';
import { describePostgres, resetPostgresFixtures } from './postgres-suite.js';

const DOCUMENT = resolve(__dirname, '..', '..', '..', 'docs', 'AUTHZ-OBJECTS.md');

/** The application with the outbox consumers that create the notices (no pg-boss in Jest). */
@Module({
  imports: APPLICATION_MODULES,
  providers: [
    {
      provide: OUTBOX_DISPATCHER_SETTINGS,
      useValue: { leaseSeconds: 60, maxAttempts: 5, retryBaseSeconds: 5, retryMaxSeconds: 300 },
    },
    {
      provide: OUTBOX_SUBSCRIBERS,
      inject: [PAYMENTS_OUTBOX_SUBSCRIBER, NOTIFICATIONS_OUTBOX_SUBSCRIBER],
      useFactory: (...subscribers: OutboxSubscriberPort[]) => subscribers,
    },
    PostgresOutboxDispatcher,
    { provide: OUTBOX_DISPATCHER, useExisting: PostgresOutboxDispatcher },
  ],
})
class ObjectsModule {}

/**
 * Answers that are not 404 today, each with its own fix PR. Empty since #73 and #74: an entry
 * that stops reproducing fails the test, so it is removed together with its fix.
 */
const KNOWN_LEAKS = new Map<string, number>();

type Account = { readonly token: string; readonly userId: string };
type Probe = {
  readonly owner: string;
  readonly intruder: string;
  readonly method: 'get' | 'post' | 'patch' | 'delete';
  readonly path: string;
  readonly body?: object;
  readonly note?: string;
};

/**
 * Object-level authorization: user A creates each resource, and user B (same role, or another
 * role that must not see it) asks for it. Every answer must be 404, as for a missing resource,
 * and A's resource must be unchanged afterwards.
 */
describePostgres('authorization by object: user B never reaches user A’s resources', () => {
  let app: INestApplication;
  let pool: pg.Pool;
  let otp: InMemoryOtpSender;
  let storage: InMemoryStorageAdapter;
  let phone = 1;
  const http = () => request(app.getHttpServer());
  const bearer = (account: Account) => ({ Authorization: `Bearer ${account.token}` });

  const register = async (
    role: 'producer' | 'supplier' | 'buyer' | 'carrier',
  ): Promise<Account> => {
    const number = `307${String(phone++).padStart(7, '0')}`;
    const deviceId = createId();
    await http()
      .post('/auth/register')
      .send({
        phone: number,
        role,
        fullName: `Persona ${role}`,
        deviceId,
        platform: 'web',
        consent: { accepted: true, version: 'v0-draft' },
      })
      .expect(201);
    const verified = await http()
      .post('/auth/otp/verify')
      .send({ phone: number, deviceId, platform: 'web', code: otp.sent.at(-1)?.code })
      .expect(201);
    return { token: verified.body.accessToken as string, userId: verified.body.user.id as string };
  };
  const profile = (account: Account) =>
    http()
      .put('/me/provider-profile')
      .set(bearer(account))
      .send({
        displayName: 'Finca sintética',
        municipality: 'Tunja',
        department: 'Boyacá',
        lat: 5.53,
        lng: -73.36,
        description: 'Dato sintético',
      })
      .expect(200);
  const dispatch = async () => {
    for (let round = 0; round < 10; round += 1)
      if ((await app.get<OutboxDispatcher>(OUTBOX_DISPATCHER).dispatch()).claimed === 0) break;
  };

  beforeAll(async () => {
    otp = new InMemoryOtpSender();
    const moduleRef = await Test.createTestingModule({ imports: [ObjectsModule] })
      .overrideProvider(OTP_SENDER)
      .useValue(otp)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    pool = app.get(DATABASE_POOL) as pg.Pool;
    storage = app.get(STORAGE_PORT) as InMemoryStorageAdapter;
  });

  afterAll(async () => app?.close());

  beforeEach(async () => {
    await resetPostgresFixtures(pool);
    otp.sent.length = 0;
  });

  it('answers 404 to user B on every route of a resource owned by user A, and changes nothing', async () => {
    const accounts = {
      producerA: await register('producer'),
      producerB: await register('producer'),
      supplierB: await register('supplier'),
      buyerA: await register('buyer'),
      buyerB: await register('buyer'),
      carrierA: await register('carrier'),
      carrierB: await register('carrier'),
    };
    const { producerA, producerB, supplierB, buyerA, carrierA, carrierB } = accounts;
    const operator = await createStaffAccount(app, pool, 'operator', '+573079990001');
    const finance = await createStaffAccount(app, pool, 'finance', '+573079990002');
    await profile(producerA);
    await profile(producerB);
    await profile(supplierB);

    const categoryId = createId();
    await http()
      .post('/catalog/categories')
      .set(bearer(operator))
      .send({ id: categoryId, name: 'Tubérculos', parentId: null })
      .expect(201);
    const productId = createId();
    await http()
      .post('/catalog/products')
      .set(bearer(operator))
      .send({ id: productId, categoryId, name: 'Papa criolla', unit: 'kg', attributes: {} })
      .expect(201);
    const lot = (id: string) => ({
      id,
      productId,
      quantityMilli: '10000',
      unit: 'kg',
      unitPrice: 4_500,
      qualityGrade: null,
      availableFrom: new Date(Date.now() - 3_600_000).toISOString(),
      availableUntil: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      locationLat: 5.53,
      locationLng: -73.36,
    });

    // A's draft lot with a pending photo, and A's published lot.
    const draftId = createId();
    await http().post('/lots').set(bearer(producerA)).send(lot(draftId)).expect(201);
    const photoId = createId();
    await http()
      .post(`/lots/${draftId}/photos`)
      .set(bearer(producerA))
      .send({ photoId })
      .expect(201);
    const publishedId = createId();
    await http().post('/lots').set(bearer(producerA)).send(lot(publishedId)).expect(201);
    await http()
      .post(`/lots/${publishedId}/publish`)
      .set(bearer(producerA))
      .send({ version: 1 })
      .expect(201);

    // A's order on it, accepted, paid with a verified proof.
    const orderId = createId();
    const order = await http()
      .post('/orders')
      .set(bearer(buyerA))
      .send({
        id: orderId,
        lines: [{ lotId: publishedId, quantityMilli: '2000' }],
        deliveryAddress: 'Calle sintética 1, Bogotá',
      })
      .expect(201);
    await http()
      .post(`/orders/${orderId}/accept`)
      .set(bearer(buyerA))
      .send({ expectedVersion: order.body.version })
      .expect(200);
    const paymentId = createId();
    await http()
      .post(`/orders/${orderId}/payment`)
      .set(bearer(buyerA))
      .send({ id: paymentId, method: 'transfer' })
      .expect(201);
    const policy = await http()
      .post(`/payments/${paymentId}/proof`)
      .set(bearer(buyerA))
      .expect(201);
    await storage.putObject({
      key: policy.body.uploadPolicy.fields.key as string,
      body: await createSyntheticJpeg(),
      contentType: 'image/jpeg',
    });
    const confirmed = await http()
      .post(`/payments/${paymentId}/proof/confirm`)
      .set(bearer(buyerA))
      .expect(200);
    await http()
      .post(`/payments/${paymentId}/verify`)
      .set(bearer(finance))
      .send({ expectedVersion: confirmed.body.version })
      .expect(200);

    // A's trip for that order, with its stops; A's notice and A's price alert.
    for (const carrier of [carrierA, carrierB])
      await http()
        .post('/logistics/carrier-profile')
        .set(bearer(carrier))
        .send({
          vehicleType: 'Camion',
          capacityKg: 2000,
          plate: carrier === carrierA ? 'OBJ001' : 'OBJ002',
        })
        .expect(201);
    const trip = await http()
      .post('/logistics/trips')
      .set(bearer(carrierA))
      .send({ id: createId(), orderIds: [orderId] })
      .expect(201);
    const tripId = trip.body.id as string;
    const stops = (
      await http().get(`/logistics/trips/${tripId}/stops`).set(bearer(carrierA)).expect(200)
    ).body as { id: string; kind: string }[];
    const pickupId = stops.find(({ kind }) => kind === 'pickup')!.id;
    await dispatch();
    const notice = await pool.query<{ id: string }>(
      `SELECT id FROM notifications.inbox WHERE user_id = $1 LIMIT 1`,
      [producerA.userId],
    );
    const noticeId = notice.rows[0]!.id;
    const alert = await http()
      .post('/alerts')
      .set(bearer(buyerA))
      .send({ id: createId(), productId, maxPrice: 5000, radiusKm: 50, lat: 4.65, lng: -74.08 })
      .expect(201);
    const alertId = alert.body.id as string;

    const paymentVersion = (
      await http().get(`/payments/${paymentId}`).set(bearer(buyerA)).expect(200)
    ).body.version as number;
    const before = await snapshot(pool);
    const probes: Probe[] = [
      // Lots: another provider, and a buyer for the draft.
      { owner: 'producerA', intruder: 'producerB', method: 'get', path: `/lots/${draftId}` },
      { owner: 'producerA', intruder: 'buyerB', method: 'get', path: `/lots/${draftId}` },
      {
        owner: 'producerA',
        intruder: 'producerB',
        method: 'patch',
        path: `/lots/${draftId}`,
        body: { version: 1, unitPrice: 1 },
      },
      {
        owner: 'producerA',
        intruder: 'supplierB',
        method: 'delete',
        path: `/lots/${draftId}`,
        body: { version: 1 },
      },
      {
        owner: 'producerA',
        intruder: 'producerB',
        method: 'post',
        path: `/lots/${draftId}/publish`,
        body: { version: 1 },
      },
      {
        owner: 'producerA',
        intruder: 'producerB',
        method: 'post',
        path: `/lots/${publishedId}/cancel`,
        body: { version: 2 },
      },
      {
        owner: 'producerA',
        intruder: 'producerB',
        method: 'post',
        path: `/lots/${draftId}/photos`,
        body: { photoId: createId() },
      },
      {
        owner: 'producerA',
        intruder: 'producerB',
        method: 'post',
        path: `/lots/${draftId}/photos/${photoId}/confirm`,
      },
      {
        owner: 'producerA',
        intruder: 'producerB',
        method: 'delete',
        path: `/lots/${draftId}/photos/${photoId}`,
      },
      {
        owner: 'producerA',
        intruder: 'producerB',
        method: 'patch',
        path: `/lots/${draftId}/photos/order`,
        body: { photoIds: [photoId] },
      },
      // Orders: another buyer, and a provider who is not in the order.
      { owner: 'buyerA', intruder: 'buyerB', method: 'get', path: `/orders/${orderId}` },
      { owner: 'buyerA', intruder: 'producerB', method: 'get', path: `/orders/${orderId}` },
      {
        owner: 'buyerA',
        intruder: 'buyerB',
        method: 'post',
        path: `/orders/${orderId}/accept`,
        body: { expectedVersion: 1 },
      },
      {
        owner: 'buyerA',
        intruder: 'buyerB',
        method: 'post',
        path: `/orders/${orderId}/cancel`,
        body: { expectedVersion: 1, reason: 'Sintético' },
      },
      { owner: 'buyerA', intruder: 'buyerB', method: 'get', path: `/orders/${orderId}/payment` },
      {
        owner: 'buyerA',
        intruder: 'buyerB',
        method: 'post',
        path: `/orders/${orderId}/payment`,
        body: { id: createId(), method: 'transfer' },
      },
      // Payments: another buyer, and a provider who is not in the order.
      { owner: 'buyerA', intruder: 'buyerB', method: 'get', path: `/payments/${paymentId}` },
      { owner: 'buyerA', intruder: 'producerB', method: 'get', path: `/payments/${paymentId}` },
      { owner: 'buyerA', intruder: 'buyerB', method: 'post', path: `/payments/${paymentId}/proof` },
      {
        owner: 'buyerA',
        intruder: 'buyerB',
        method: 'post',
        path: `/payments/${paymentId}/proof/confirm`,
      },
      {
        owner: 'buyerA',
        intruder: 'buyerB',
        method: 'post',
        path: `/payments/${paymentId}/dispute`,
        body: { expectedVersion: paymentVersion + 1, reason: 'Sintético' },
        note: 'wrong version',
      },
      {
        owner: 'buyerA',
        intruder: 'buyerB',
        method: 'post',
        path: `/payments/${paymentId}/dispute`,
        body: { expectedVersion: paymentVersion, reason: 'Sintético' },
        note: 'current version',
      },
      // Logistics: another carrier; buyer and provider for the exact location.
      {
        owner: 'carrierA',
        intruder: 'carrierB',
        method: 'get',
        path: `/logistics/trips/${tripId}`,
      },
      {
        owner: 'carrierA',
        intruder: 'carrierB',
        method: 'get',
        path: `/logistics/trips/${tripId}/stops`,
      },
      {
        owner: 'carrierA',
        intruder: 'carrierB',
        method: 'post',
        path: `/logistics/trips/${tripId}/start`,
        body: { expectedVersion: 2 },
      },
      {
        owner: 'carrierA',
        intruder: 'carrierB',
        method: 'post',
        path: `/logistics/trips/${tripId}/complete`,
        body: { expectedVersion: 2 },
      },
      {
        owner: 'carrierA',
        intruder: 'carrierB',
        method: 'post',
        path: `/logistics/trips/${tripId}/cancel`,
        body: { expectedVersion: 2, reason: 'Sintético' },
      },
      {
        owner: 'carrierA',
        intruder: 'carrierB',
        method: 'post',
        path: `/logistics/stops/${pickupId}/checkins`,
        body: { id: createId(), kind: 'pickup', clientAt: new Date().toISOString() },
      },
      ...(['carrierB', 'buyerB', 'buyerA', 'producerA'] as const).flatMap((intruder) => [
        {
          owner: 'carrierA',
          intruder,
          method: 'get' as const,
          path: `/logistics/trips/${tripId}/stops/${pickupId}/location`,
        },
        {
          owner: 'carrierA',
          intruder,
          method: 'get' as const,
          path: `/logistics/trips/${tripId}/location-pack`,
        },
      ]),
      // Notices, alerts and ratings.
      {
        owner: 'producerA',
        intruder: 'producerB',
        method: 'post',
        path: `/me/inbox/${noticeId}/read`,
      },
      { owner: 'buyerA', intruder: 'buyerB', method: 'delete', path: `/alerts/${alertId}` },
      {
        owner: 'buyerA',
        intruder: 'buyerB',
        method: 'post',
        path: '/trust/ratings',
        body: { id: createId(), orderId, ratee: 'provider', score: 1 },
      },
    ];

    const results: { probe: Probe; status: number }[] = [];
    for (const probe of probes) {
      const account = accounts[probe.intruder as keyof typeof accounts];
      let pending = http()[probe.method](probe.path).set(bearer(account));
      if (probe.body) pending = pending.send(probe.body);
      results.push({ probe, status: (await pending).status });
    }
    const ids = new Map([
      [draftId, '{borrador de A}'],
      [publishedId, '{lote publicado de A}'],
      [photoId, '{foto de A}'],
      [orderId, '{pedido de A}'],
      [paymentId, '{pago de A}'],
      [tripId, '{viaje de A}'],
      [pickupId, '{parada de A}'],
      [noticeId, '{aviso de A}'],
      [alertId, '{alerta de A}'],
    ]);
    const generic = (path: string) =>
      [...ids].reduce((text, [id, name]) => text.split(id).join(name), path);
    const label = (probe: Probe) =>
      `${probe.method.toUpperCase()} ${generic(probe.path)} as ${probe.intruder}${probe.note ? ` (${probe.note})` : ''}`;
    const unexpected = results
      .filter(({ probe, status }) => status !== (KNOWN_LEAKS.get(label(probe)) ?? 404))
      .map(({ probe, status }) => `${label(probe)} → ${status}`);
    expect(unexpected).toEqual([]);
    expect(
      [...KNOWN_LEAKS.keys()].filter((key) => !results.some(({ probe }) => label(probe) === key)),
    ).toEqual([]);
    // Nothing of A's changed: lots, order, payment, trip, notice, alert, audit log.
    expect(await snapshot(pool)).toEqual(before);
    const denials = await pool.query(
      `SELECT count(*)::int AS n FROM backoffice.audit_log WHERE action = 'location.view'`,
    );
    expect(denials.rows[0].n).toBe(8); // 4 users × 2 location routes

    const document = formatMarkdown(
      [
        '# Autorización por objeto',
        '',
        'Generada por `apps/api/test/authz-objects.e2e-spec.ts` (regenerar con `UPDATE_AUTHZ_MATRIX=1`); la prueba falla si este archivo no coincide. El usuario A crea cada recurso y el usuario B lo pide: la respuesta debe ser `404`, la misma que para un recurso que no existe, y los datos de A no deben cambiar (se comparan antes y después).',
        '',
        '| Ruta | Dueño | Quien lo pide | Estado |',
        '| ---- | ----- | ------------- | ------ |',
        ...results.map(
          ({ probe, status }) =>
            `| \`${probe.method.toUpperCase()} ${generic(probe.path)}\` | ${probe.owner} | ${probe.intruder}${probe.note ? ` (${probe.note})` : ''} | ${status}${KNOWN_LEAKS.has(label(probe)) ? ' (por corregir)' : ''} |`,
        ),
        '',
      ].join('\n'),
      DOCUMENT,
    );
    if (process.env.UPDATE_AUTHZ_MATRIX === '1') writeFileSync(DOCUMENT, document);
    expect(readFileSync(DOCUMENT, 'utf8')).toBe(document);
  }, 120_000);
});

/** The state user B must not be able to change. */
const snapshot = async (pool: pg.Pool) => {
  const rows = async (sql: string) => (await pool.query(sql)).rows;
  return {
    lots: await rows(`SELECT id, status, version, unit_price FROM catalog.lots ORDER BY id`),
    photos: await rows(`SELECT id, state, deleted_at FROM catalog.lot_photos ORDER BY id`),
    orders: await rows(`SELECT id, status, version FROM ordering.orders ORDER BY id`),
    payments: await rows(`SELECT id, status, version FROM payments.payments ORDER BY id`),
    trips: await rows(`SELECT id, status, version FROM logistics.trips ORDER BY id`),
    checkins: await rows(`SELECT id FROM logistics.checkins ORDER BY id`),
    inbox: await rows(`SELECT id, read_at FROM notifications.inbox ORDER BY id`),
    alerts: await rows(`SELECT id, deleted_at FROM recommendations.price_alerts ORDER BY id`),
    ratings: await rows(`SELECT id FROM trust.ratings ORDER BY id`),
    // Location reads are audited even when denied (LG-06); every other audit row must not change.
    audit: await rows(
      `SELECT action FROM backoffice.audit_log WHERE action <> 'location.view' ORDER BY at, id`,
    ),
  };
};
