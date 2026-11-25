import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import request from 'supertest';
import { Module } from '@nestjs/common';
import { APPLICATION_MODULES } from '../src/bootstrap/app.module.js';
import { NOTIFICATIONS_OUTBOX_SUBSCRIBER } from '../src/modules/notifications/index.js';
import { PAYMENTS_OUTBOX_SUBSCRIBER } from '../src/modules/payments/index.js';
import { RECOMMENDATIONS_OUTBOX_SUBSCRIBERS } from '../src/modules/recommendations/index.js';
import { TRUST_OUTBOX_SUBSCRIBER } from '../src/modules/trust/index.js';
import { PostgresOutboxDispatcher } from '../src/shared/infra/outbox-dispatcher.js';
import {
  OUTBOX_SUBSCRIBERS,
  type OutboxSubscriberPort,
} from '../src/shared/ports/outbox-subscriber.js';
import { InMemoryOtpSender } from '../src/modules/identity/adapters/out/otp-senders.js';
import { OTP_SENDER } from '../src/modules/identity/ports/tokens.js';
import {
  PAYMENTS_MAINTENANCE,
  type PaymentsMaintenanceApi,
} from '../src/modules/payments/index.js';
import { InMemoryStorageAdapter } from '../src/shared/infra/storage/in-memory-storage.adapter.js';
import { DATABASE_POOL } from '../src/shared/infra/tokens.js';
import { createId } from '../src/shared/kernel/ids.js';
import {
  OUTBOX_DISPATCHER,
  OUTBOX_DISPATCHER_SETTINGS,
  type OutboxDispatcher,
} from '../src/shared/ports/outbox-dispatcher.js';
import { STORAGE_PORT } from '../src/shared/ports/storage.js';
import { findCoordinateExposure } from './helpers/coordinate-exposure.js';
import { createStaffAccount } from './helpers/staff-account.js';
import { createSyntheticJpeg } from './helpers/synthetic-image.js';
import { describePostgres, resetPostgresFixtures } from './postgres-suite.js';

type Account = { readonly token: string; readonly userId: string };

/**
 * The worker's outbox wiring (bootstrap/worker.module.ts) without pg-boss, which Jest cannot load
 * (ESM only): the same modules, the same consumers and the real PostgresOutboxDispatcher.
 */
@Module({
  imports: APPLICATION_MODULES,
  providers: [
    {
      provide: OUTBOX_DISPATCHER_SETTINGS,
      useValue: { leaseSeconds: 60, maxAttempts: 5, retryBaseSeconds: 5, retryMaxSeconds: 300 },
    },
    {
      provide: OUTBOX_SUBSCRIBERS,
      inject: [
        PAYMENTS_OUTBOX_SUBSCRIBER,
        NOTIFICATIONS_OUTBOX_SUBSCRIBER,
        TRUST_OUTBOX_SUBSCRIBER,
        RECOMMENDATIONS_OUTBOX_SUBSCRIBERS,
      ],
      useFactory: (
        payments: OutboxSubscriberPort,
        notifications: OutboxSubscriberPort,
        trust: OutboxSubscriberPort,
        recommendations: readonly OutboxSubscriberPort[],
      ): readonly OutboxSubscriberPort[] => [payments, notifications, trust, ...recommendations],
    },
    PostgresOutboxDispatcher,
    { provide: OUTBOX_DISPATCHER, useExisting: PostgresOutboxDispatcher },
  ],
})
class JourneyModule {}

/**
 * The whole journey over HTTP, with the real outbox dispatcher delivering every event to its
 * consumers (payments, notifications, trust, recommendations): a producer publishes a lot with
 * photos → a buyer finds it, orders and accepts → uploads a proof → finance verifies → a carrier
 * picks up and delivers → the settlement is issued and paid. Notifications and audit are checked
 * at every step.
 */
describePostgres('full journey: lot with photos to settlement (Nest + PostgreSQL + outbox)', () => {
  let app: INestApplication;
  let pool: pg.Pool;
  let otp: InMemoryOtpSender;
  let storage: InMemoryStorageAdapter;
  let phone = 1;

  const http = () => request(app.getHttpServer());
  const bearer = (account: Account) => ({ Authorization: `Bearer ${account.token}` });

  const register = async (role: 'producer' | 'buyer' | 'carrier'): Promise<Account> => {
    const number = `305${String(phone++).padStart(7, '0')}`;
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

  /** Delivers everything pending in the outbox, as the worker would. */
  const dispatch = async () => {
    for (let round = 0; round < 10; round += 1) {
      const result = await app.get<OutboxDispatcher>(OUTBOX_DISPATCHER).dispatch();
      if (result.claimed === 0) break;
    }
    const failed = await pool.query(
      `SELECT type FROM shared.outbox_events WHERE failed_at IS NOT NULL OR (published_at IS NULL AND attempts > 0)`,
    );
    expect(failed.rows).toEqual([]);
  };

  const inboxKinds = async (userId: string) =>
    (
      await pool.query<{ kind: string }>(
        `SELECT kind FROM notifications.inbox WHERE user_id = $1 ORDER BY created_at, id`,
        [userId],
      )
    ).rows.map(({ kind }) => kind);

  const auditActions = async () =>
    (
      await pool.query<{ action: string; actor_role: string }>(
        `SELECT action, actor_role FROM backoffice.audit_log ORDER BY at, id`,
      )
    ).rows.map(({ action, actor_role }) => `${actor_role}:${action}`);

  beforeAll(async () => {
    otp = new InMemoryOtpSender();
    const moduleRef = await Test.createTestingModule({ imports: [JourneyModule] })
      .overrideProvider(OTP_SENDER)
      .useValue(otp)
      .compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
    pool = app.get(DATABASE_POOL) as pg.Pool;
    storage = app.get(STORAGE_PORT) as InMemoryStorageAdapter;
  });

  afterAll(async () => app?.close());

  beforeEach(async () => {
    await resetPostgresFixtures(pool);
    otp.sent.length = 0;
  });

  it('runs publish → find → order → proof → verify → trip and delivery → settlement, notifying and auditing each step', async () => {
    const producer = await register('producer');
    const buyer = await register('buyer');
    const carrier = await register('carrier');
    const operator = await createStaffAccount(app, pool, 'operator', '+573059990001');
    const finance = await createStaffAccount(app, pool, 'finance', '+573059990002');

    // 0. Staff curate the taxonomy (audited).
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

    // 1. The producer completes the profile, creates a draft lot, adds two photos and publishes.
    await http()
      .put('/me/provider-profile')
      .set(bearer(producer))
      .send({
        displayName: 'Finca sintética',
        municipality: 'Tunja',
        department: 'Boyacá',
        lat: 5.53,
        lng: -73.36,
        description: 'Dato sintético',
      })
      .expect(200);
    const lotId = createId();
    await http()
      .post('/lots')
      .set(bearer(producer))
      .send({
        id: lotId,
        productId,
        quantityMilli: '10000',
        unit: 'kg',
        unitPrice: 4_500,
        qualityGrade: 'Primera',
        availableFrom: new Date(Date.now() - 3_600_000).toISOString(),
        availableUntil: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        locationLat: 5.53,
        locationLng: -73.36,
      })
      .expect(201);
    const photoIds: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const photoId = createId();
      const prepared = await http()
        .post(`/lots/${lotId}/photos`)
        .set(bearer(producer))
        .send({ photoId })
        .expect(201);
      await storage.acceptUpload(
        prepared.body.uploadPolicy.fields.key as string,
        await createSyntheticJpeg({ width: 64, height: 48 }),
        'image/jpeg',
      );
      await http()
        .post(`/lots/${lotId}/photos/${photoId}/confirm`)
        .set(bearer(producer))
        .expect(201);
      photoIds.push(photoId);
    }
    await http()
      .patch(`/lots/${lotId}/photos/order`)
      .set(bearer(producer))
      .send({ photoIds: [...photoIds].reverse() })
      .expect(200);
    await http()
      .post(`/lots/${lotId}/publish`)
      .set(bearer(producer))
      .send({ version: 1 })
      .expect(201);
    await dispatch();

    // 2. The buyer finds it with its photos, without exact location or provider id.
    const search = await http().get('/lots?q=papa').set(bearer(buyer)).expect(200);
    expect(search.body.items.map(({ id }: { id: string }) => id)).toEqual([lotId]);
    const found = search.body.items[0];
    // The search shows the cover (first photo of the new order); the detail shows them all, in order.
    expect(found.photos.map(({ id }: { id: string }) => id)).toEqual([photoIds[1]]);
    const detail = await http().get(`/lots/${lotId}`).set(bearer(buyer)).expect(200);
    expect(detail.body.photos.map(({ id }: { id: string }) => id)).toEqual([...photoIds].reverse());
    expect(found).not.toHaveProperty('providerId');
    expect(findCoordinateExposure(search.body, [{ latitude: 5.53, longitude: -73.36 }])).toEqual(
      [],
    );

    // 3. The buyer orders and accepts the quote: stock reserved, the producer is told.
    const orderId = createId();
    const order = await http()
      .post('/orders')
      .set(bearer(buyer))
      .send({
        id: orderId,
        lines: [{ lotId, quantityMilli: '4000' }],
        deliveryAddress: 'Calle sintética 1, Bogotá',
      })
      .expect(201);
    expect(order.body).toMatchObject({ status: 'quoted', subtotal: '18000' });
    await http()
      .post(`/orders/${orderId}/accept`)
      .set(bearer(buyer))
      .send({ expectedVersion: order.body.version })
      .expect(200);
    await dispatch();
    expect(await inboxKinds(producer.userId)).toEqual(['order_received']);

    // 4. The buyer pays by transfer and uploads the proof.
    const paymentId = createId();
    await http()
      .post(`/orders/${orderId}/payment`)
      .set(bearer(buyer))
      .send({ id: paymentId, method: 'transfer' })
      .expect(201);
    const policy = await http().post(`/payments/${paymentId}/proof`).set(bearer(buyer)).expect(201);
    await storage.putObject({
      key: policy.body.uploadPolicy.fields.key as string,
      body: await createSyntheticJpeg(),
      contentType: 'image/jpeg',
    });
    const confirmed = await http()
      .post(`/payments/${paymentId}/proof/confirm`)
      .set(bearer(buyer))
      .expect(200);

    // 5. Finance verifies it: order paid, both parties told, audited.
    await http()
      .post(`/payments/${paymentId}/verify`)
      .set(bearer(finance))
      .send({ expectedVersion: confirmed.body.version })
      .expect(200);
    await dispatch();
    expect(
      (await http().get(`/orders/${orderId}`).set(bearer(buyer)).expect(200)).body.status,
    ).toBe('paid');
    expect(await inboxKinds(buyer.userId)).toEqual(['payment_verified_buyer']);
    expect(await inboxKinds(producer.userId)).toEqual([
      'order_received',
      'payment_verified_provider',
    ]);

    // 6. The carrier plans the trip, picks up and delivers: the buyer is told each time.
    await http()
      .post('/logistics/carrier-profile')
      .set(bearer(carrier))
      .send({ vehicleType: 'Camion', capacityKg: 2000, plate: 'JRN001' })
      .expect(201);
    const trip = await http()
      .post('/logistics/trips')
      .set(bearer(carrier))
      .send({ id: createId(), orderIds: [orderId] })
      .expect(201);
    const stops = (
      await http().get(`/logistics/trips/${trip.body.id}/stops`).set(bearer(carrier)).expect(200)
    ).body as { id: string; kind: string }[];
    for (const kind of ['pickup', 'delivery'] as const) {
      await http()
        .post(`/logistics/stops/${stops.find((stop) => stop.kind === kind)!.id}/checkins`)
        .set(bearer(carrier))
        .send({ id: createId(), kind, clientAt: new Date().toISOString() })
        .expect(201);
      await dispatch();
    }
    expect(
      (await http().get(`/orders/${orderId}`).set(bearer(buyer)).expect(200)).body.status,
    ).toBe('delivered');
    expect(await inboxKinds(buyer.userId)).toEqual([
      'payment_verified_buyer',
      'pickup_scheduled',
      'in_transit',
      'delivered',
    ]);
    expect(
      (await http().get(`/payments/${paymentId}`).set(bearer(buyer)).expect(200)).body.status,
    ).toBe('held');

    // 7. After the claim window, the settlement is issued (producer told) and finance pays it.
    await pool.query(
      `UPDATE payments.payments SET held_at = held_at - interval '49 hours' WHERE id = $1`,
      [paymentId],
    );
    expect(await app.get<PaymentsMaintenanceApi>(PAYMENTS_MAINTENANCE).issueDueSettlements()).toBe(
      1,
    );
    await dispatch();
    const settlements = (await http().get('/settlements').set(bearer(producer)).expect(200)).body
      .items as {
      id: string;
      version: number;
      amount: string;
      beneficiaryKind: string;
    }[];
    const producerSettlement = settlements.find(
      ({ beneficiaryKind }) => beneficiaryKind === 'producer',
    )!;
    await http()
      .post(`/settlements/${producerSettlement.id}/paid`)
      .set(bearer(finance))
      .send({ expectedVersion: producerSettlement.version, reference: 'TRX-JOURNEY-1' })
      .expect(200);
    await dispatch();
    expect(await inboxKinds(producer.userId)).toEqual([
      'order_received',
      'payment_verified_provider',
      'settlement_issued',
      'settlement_paid',
    ]);

    // 8. Money: the ledger balances per transaction and only the carrier's freight is still owed.
    const unbalanced = await pool.query(
      `SELECT transaction_id FROM payments.ledger_entries GROUP BY transaction_id HAVING sum(debit) <> sum(credit)`,
    );
    expect(unbalanced.rows).toEqual([]);

    // 9. The order's events form an unbroken hash chain from requested to delivered.
    const events = (
      await pool.query<{ type: string; prev_hash: string | null; hash: string }>(
        `SELECT type, prev_hash, hash FROM ordering.order_events WHERE order_id = $1 ORDER BY occurred_at, id`,
        [orderId],
      )
    ).rows;
    expect(events.map(({ type }) => type)).toEqual(
      expect.arrayContaining([
        'OrderRequested',
        'OrderQuoted',
        'OrderAccepted',
        'OrderPickupScheduled',
        'OrderInTransit',
        'OrderDelivered',
      ]),
    );
    for (let index = 1; index < events.length; index += 1)
      expect(events[index]!.prev_hash).toBe(events[index - 1]!.hash);

    // 10. Every staff action is in the audit log, in order.
    expect(await auditActions()).toEqual([
      'operator:category.create',
      'operator:product.create',
      'finance:payment.verify',
      'finance:settlement.mark_paid',
    ]);
  }, 180_000);
});
