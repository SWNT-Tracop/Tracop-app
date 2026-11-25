import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import sharp from 'sharp';
import request from 'supertest';
import { AppModule } from '../src/bootstrap/app.module.js';
import { InMemoryOtpSender } from '../src/modules/identity/adapters/out/otp-senders.js';
import { OTP_SENDER } from '../src/modules/identity/ports/tokens.js';
import {
  PAYMENTS_MAINTENANCE,
  PAYMENTS_OUTBOX_SUBSCRIBER,
  PAYMENTS_SERVICE,
  type PaymentsMaintenanceApi,
  type PaymentsService,
} from '../src/modules/payments/index.js';
import { InMemoryStorageAdapter } from '../src/shared/infra/storage/in-memory-storage.adapter.js';
import { DATABASE_POOL } from '../src/shared/infra/tokens.js';
import { createId } from '../src/shared/kernel/ids.js';
import type {
  OutboxEventRecord,
  OutboxSubscriberPort,
} from '../src/shared/ports/outbox-subscriber.js';
import { STORAGE_PORT } from '../src/shared/ports/storage.js';
import { createStaffAccount } from './helpers/staff-account.js';
import { createSyntheticJpeg } from './helpers/synthetic-image.js';
import { describePostgres, resetPostgresFixtures } from './postgres-suite.js';

const ITERATIONS = 10;
const CONCURRENCY_TEST_TIMEOUT_MS = 180_000;
type Account = { readonly token: string; readonly userId: string };

describePostgres('payments over HTTP (Nest + PostgreSQL)', () => {
  let app: INestApplication;
  let pool: pg.Pool;
  let otpSender: InMemoryOtpSender;
  let storage: InMemoryStorageAdapter;
  let service: PaymentsService;
  let phoneSequence = 1;
  let productId: string;

  const http = () => request(app.getHttpServer());
  const bearer = (account: Account) => ({ Authorization: `Bearer ${account.token}` });
  const nextPhone = () => `305${String(phoneSequence++).padStart(7, '0')}`;

  const register = async (role: 'buyer' | 'supplier' | 'carrier'): Promise<Account> => {
    const phone = nextPhone();
    const deviceId = createId();
    await http()
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
    const verified = await http()
      .post('/auth/otp/verify')
      .send({ phone, deviceId, platform: 'web', code: otpSender.sent.at(-1)?.code })
      .expect(201);
    return { token: verified.body.accessToken as string, userId: verified.body.user.id as string };
  };

  const staff = (role: 'finance' | 'operator') =>
    createStaffAccount(app, pool, role, `+57${nextPhone()}`);

  const supplierWithLot = async (quantityKg: number) => {
    const supplier = await register('supplier');
    await http()
      .put('/me/provider-profile')
      .set(bearer(supplier))
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
      .set(bearer(supplier))
      .send({
        id: lotId,
        productId,
        quantityMilli: String(quantityKg * 1000),
        unit: 'kg',
        unitPrice: 4_500,
        qualityGrade: 'Primera',
        availableFrom: new Date(Date.now() - 3_600_000).toISOString(),
        availableUntil: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        locationLat: 5.53,
        locationLng: -73.36,
      })
      .expect(201);
    await http()
      .post(`/lots/${lotId}/publish`)
      .set(bearer(supplier))
      .send({ version: 1 })
      .expect(201);
    return { supplier, lotId };
  };

  /** An accepted order for `quantityKg` of the lot. */
  const acceptedOrder = async (buyer: Account, lotId: string, quantityKg: number) => {
    const id = createId();
    const created = await http()
      .post('/orders')
      .set(bearer(buyer))
      .send({
        id,
        lines: [{ lotId, quantityMilli: String(quantityKg * 1000) }],
        deliveryAddress: 'Calle 1 # 2-3, Chapinero, Bogotá',
      })
      .expect(201);
    await http()
      .post(`/orders/${id}/accept`)
      .set(bearer(buyer))
      .send({ expectedVersion: created.body.version })
      .expect(200);
    return id;
  };

  const initiate = (buyer: Account, orderId: string, paymentId = createId()) =>
    http()
      .post(`/orders/${orderId}/payment`)
      .set(bearer(buyer))
      .send({ id: paymentId, method: 'transfer' });

  /** Uploads a synthetic JPEG proof (with GPS metadata) and confirms it. */
  const uploadProof = async (buyer: Account, paymentId: string) => {
    const policy = await http().post(`/payments/${paymentId}/proof`).set(bearer(buyer)).expect(201);
    const key = policy.body.uploadPolicy.fields.key as string;
    await storage.putObject({
      key,
      body: await createSyntheticJpeg({ gps: { latitude: 5.53, longitude: -73.36 } }),
      contentType: 'image/jpeg',
    });
    return http().post(`/payments/${paymentId}/proof/confirm`).set(bearer(buyer));
  };

  const orderState = async (orderId: string) =>
    (
      await pool.query<{ status: string; version: number }>(
        `SELECT status, version FROM ordering.orders WHERE id = $1`,
        [orderId],
      )
    ).rows[0]!;

  const reservation = async (orderId: string) =>
    (
      await pool.query<{ status: string; expires_at: Date | null }>(
        `SELECT status, expires_at FROM catalog.lot_reservations WHERE order_id = $1`,
        [orderId],
      )
    ).rows[0]!;

  const ledgerBalance = async (orderId: string) => {
    const rows = await pool.query<{ account: string; balance: string }>(
      `SELECT account, (sum(debit) - sum(credit))::text AS balance
       FROM payments.ledger_entries WHERE order_id = $1 GROUP BY account ORDER BY account`,
      [orderId],
    );
    return Object.fromEntries(
      rows.rows.filter((row) => row.balance !== '0').map((row) => [row.account, row.balance]),
    );
  };

  /** Carrier picks up and delivers the order, then the outbox OrderDelivered event is consumed. */
  const deliver = async (orderId: string) => {
    const carrier = await register('carrier');
    await http()
      .post('/logistics/carrier-profile')
      .set(bearer(carrier))
      .send({ vehicleType: 'Camion', capacityKg: 2000, plate: `PAY${String(phoneSequence)}` })
      .expect(201);
    const trip = await http()
      .post('/logistics/trips')
      .set(bearer(carrier))
      .send({ id: createId(), orderIds: [orderId] })
      .expect(201);
    const stops = await http()
      .get(`/logistics/trips/${trip.body.id}/stops`)
      .set(bearer(carrier))
      .expect(200);
    for (const kind of ['pickup', 'delivery'] as const) {
      const stop = (stops.body as { id: string; kind: string }[]).find((s) => s.kind === kind)!;
      await http()
        .post(`/logistics/stops/${stop.id}/checkins`)
        .set(bearer(carrier))
        .send({ id: createId(), kind, clientAt: new Date().toISOString() })
        .expect(201);
    }
    const [event] = (
      await pool.query<{
        id: string;
        aggregate: string;
        type: string;
        payload: Record<string, unknown>;
        created_at: Date;
        attempts: number;
      }>(
        `SELECT id, aggregate, type, payload, created_at, attempts FROM shared.outbox_events
         WHERE aggregate = $1 AND type = 'OrderDelivered'`,
        [`order:${orderId}`],
      )
    ).rows;
    const record: OutboxEventRecord = {
      id: event!.id,
      aggregate: event!.aggregate,
      type: event!.type,
      payload: event!.payload,
      createdAt: event!.created_at,
      attempts: event!.attempts,
    };
    const subscriber = app.get<OutboxSubscriberPort>(PAYMENTS_OUTBOX_SUBSCRIBER);
    await subscriber.handle(record);
    // At-least-once delivery: handling the same event again changes nothing.
    await subscriber.handle(record);
    return carrier;
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
    storage = app.get(STORAGE_PORT) as InMemoryStorageAdapter;
    service = app.get<PaymentsService>(PAYMENTS_SERVICE);
  });

  beforeEach(async () => {
    await resetPostgresFixtures(pool);
    otpSender.sent.length = 0;
    phoneSequence = 1;
    const categoryId = createId();
    productId = createId();
    await pool.query(
      `INSERT INTO catalog.categories (id, name, parent_id, depth, created_at, updated_at)
       VALUES ($1, 'Tubérculos', NULL, 1, now(), now())`,
      [categoryId],
    );
    await pool.query(
      `INSERT INTO catalog.products (id, category_id, name, search_text, unit, attributes, created_at, updated_at)
       VALUES ($1, $2, 'Papa criolla', 'papa criolla', 'kg', '{}', now(), now())`,
      [productId, categoryId],
    );
  });

  afterAll(async () => app.close());

  it('pays, delivers, settles and closes an order end to end', async () => {
    const { supplier, lotId } = await supplierWithLot(10);
    const buyer = await register('buyer');
    const otherBuyer = await register('buyer');
    const finance = await staff('finance');
    const orderId = await acceptedOrder(buyer, lotId, 10);

    // 1. The buyer chooses transfer: the order waits for payment. Repeating is idempotent.
    const paymentId = createId();
    const created = await initiate(buyer, orderId, paymentId).expect(201);
    expect(created.body).toMatchObject({
      id: paymentId,
      status: 'pending',
      total: '45000',
      proofUrl: null,
    });
    const again = await initiate(buyer, orderId).expect(200);
    expect(again.body.id).toBe(paymentId);
    expect((await orderState(orderId)).status).toBe('payment_pending');

    // Nobody else learns the payment exists.
    await initiate(otherBuyer, orderId).expect(404);
    await http().get(`/payments/${paymentId}`).set(bearer(supplier)).expect(404);
    await http().get(`/orders/${orderId}/payment`).set(bearer(otherBuyer)).expect(404);
    await http().post(`/payments/${paymentId}/proof`).set(bearer(otherBuyer)).expect(404);

    // 2. The proof is stored re-encoded as WebP without metadata; the stock no longer lapses.
    const confirmed = await uploadProof(buyer, paymentId);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toMatchObject({
      status: 'proof_uploaded',
      proofUrl: expect.any(String),
    });
    // Object keys are never response fields; the proof is reachable only through the signed URL.
    for (const field of ['proofKey', 'proofIncomingKey', 'buyerId', 'providerId', 'carrierId'])
      expect(confirmed.body).not.toHaveProperty(field);
    const [stored] = (
      await pool.query<{ proof_key: string; proof_incoming_key: string | null }>(
        `SELECT proof_key, proof_incoming_key FROM payments.payments WHERE id = $1`,
        [paymentId],
      )
    ).rows;
    expect(stored!.proof_incoming_key).toBeNull();
    const proofMetadata = await sharp(
      Buffer.from(await storage.getObject(stored!.proof_key)),
    ).metadata();
    expect(proofMetadata.format).toBe('webp');
    expect(proofMetadata.exif).toBeUndefined();
    expect(await reservation(orderId)).toEqual({ status: 'active', expires_at: null });

    // 3. Finance sees it in the queue and verifies it: paid, stock sold, funds held.
    const queue = await http().get('/payments/review').set(bearer(finance)).expect(200);
    expect(queue.body.items.map((item: { id: string }) => item.id)).toEqual([paymentId]);
    await http().get('/payments/review').set(bearer(buyer)).expect(403);
    await http()
      .post(`/payments/${paymentId}/verify`)
      .set(bearer(buyer))
      .send({ expectedVersion: confirmed.body.version })
      .expect(403);
    await http()
      .post(`/payments/${paymentId}/verify`)
      .set(bearer(finance))
      .send({ expectedVersion: confirmed.body.version + 1 })
      .expect(409);
    const verified = await http()
      .post(`/payments/${paymentId}/verify`)
      .set(bearer(finance))
      .send({ expectedVersion: confirmed.body.version })
      .expect(200);
    expect(verified.body.status).toBe('verified');
    expect((await orderState(orderId)).status).toBe('paid');
    expect(await reservation(orderId)).toEqual({ status: 'consumed', expires_at: null });
    const lot = await http().get(`/lots/${lotId}`).set(bearer(supplier)).expect(200);
    expect(lot.body).toMatchObject({ status: 'sold_out', availableQuantityMilli: '0' });
    expect(await ledgerBalance(orderId)).toEqual({
      cash_held: '45000',
      payable_buyer_funds: '-45000',
    });

    // 4. Delivered: the payment is held for the claim window (consumed twice, applied once).
    await deliver(orderId);
    expect((await orderState(orderId)).status).toBe('delivered');
    const held = await http().get(`/payments/${paymentId}`).set(bearer(buyer)).expect(200);
    expect(held.body.status).toBe('held');
    expect(await ledgerBalance(orderId)).toEqual({
      cash_held: '45000',
      payable_producer: '-45000',
    });

    // 5. Settlements are issued only once the claim window is over.
    const maintenance = app.get<PaymentsMaintenanceApi>(PAYMENTS_MAINTENANCE);
    expect(await maintenance.issueDueSettlements()).toBe(0);
    await pool.query(
      `UPDATE payments.payments SET held_at = held_at - interval '49 hours' WHERE id = $1`,
      [paymentId],
    );
    expect(await maintenance.issueDueSettlements()).toBe(1);
    expect(await maintenance.issueDueSettlements()).toBe(0);
    const mine = await http().get('/settlements').set(bearer(supplier)).expect(200);
    expect(mine.body.items).toEqual([
      expect.objectContaining({ beneficiaryKind: 'producer', amount: '45000', status: 'issued' }),
    ]);
    expect((await http().get('/settlements').set(bearer(otherBuyer))).status).toBe(403);
    const settlement = mine.body.items[0] as { id: string; version: number };

    // 6. Finance pays it: the payment is settled and the order closed.
    await http()
      .post(`/settlements/${settlement.id}/paid`)
      .set(bearer(supplier))
      .send({ expectedVersion: settlement.version })
      .expect(403);
    const paid = await http()
      .post(`/settlements/${settlement.id}/paid`)
      .set(bearer(finance))
      .send({ expectedVersion: settlement.version, reference: 'TRX-0001' })
      .expect(200);
    expect(paid.body).toMatchObject({ status: 'paid', reference: 'TRX-0001' });
    await http()
      .post(`/settlements/${settlement.id}/paid`)
      .set(bearer(finance))
      .send({ expectedVersion: paid.body.version })
      .expect(409);
    expect((await http().get(`/payments/${paymentId}`).set(bearer(buyer))).body.status).toBe(
      'settled',
    );
    expect((await orderState(orderId)).status).toBe('closed');
    expect(await ledgerBalance(orderId)).toEqual({});
    const ledger = await http().get(`/orders/${orderId}/ledger`).set(bearer(finance)).expect(200);
    expect(ledger.body.items.map((entry: { kind: string }) => entry.kind)).toEqual([
      'payment_verified',
      'payment_verified',
      'delivery_confirmed',
      'delivery_confirmed',
      'settlement_paid_producer',
      'settlement_paid_producer',
    ]);
    await http().get(`/orders/${orderId}/ledger`).set(bearer(buyer)).expect(403);

    // Every transition left its event, with the actor, in the append-only trail.
    const events = await pool.query<{ type: string }>(
      `SELECT type FROM payments.payment_events WHERE payment_id = $1 ORDER BY occurred_at, id`,
      [paymentId],
    );
    expect(events.rows.map(({ type }) => type)).toEqual([
      'PaymentInitiated',
      'PaymentProofUploaded',
      'PaymentVerified',
      'PaymentHeld',
      'SettlementIssued',
      'SettlementPaid',
      'PaymentSettled',
    ]);
    // Staff actions are in the audit log, with the actor, in the same transactions.
    const audited = await pool.query<{ actor_id: string; action: string }>(
      `SELECT actor_id, action FROM backoffice.audit_log ORDER BY at, id`,
    );
    expect(audited.rows).toEqual([
      { actor_id: finance.userId, action: 'payment.verify' },
      { actor_id: finance.userId, action: 'settlement.mark_paid' },
    ]);
    // Settlement events name the beneficiary so notifications can reach them.
    const issued = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM shared.outbox_events
       WHERE aggregate = $1 AND type IN ('SettlementIssued', 'SettlementPaid') ORDER BY created_at, id`,
      [`payment:${paymentId}`],
    );
    expect(issued.rows.map(({ payload }) => payload.beneficiaryId)).toEqual([
      supplier.userId,
      supplier.userId,
    ]);
  });

  it('rejects a proof: the order keeps waiting, the stock lapses after the grace window and the buyer pays again', async () => {
    const { lotId } = await supplierWithLot(10);
    const buyer = await register('buyer');
    const finance = await staff('finance');
    const orderId = await acceptedOrder(buyer, lotId, 2);
    const first = (await initiate(buyer, orderId).expect(201)).body as { id: string };
    const confirmed = await uploadProof(buyer, first.id);

    await http()
      .post(`/payments/${first.id}/reject`)
      .set(bearer(finance))
      .send({ expectedVersion: confirmed.body.version, reason: '   ' })
      .expect(400);
    const before = Date.now();
    const rejected = await http()
      .post(`/payments/${first.id}/reject`)
      .set(bearer(finance))
      .send({ expectedVersion: confirmed.body.version, reason: 'El comprobante es ilegible.' })
      .expect(200);
    expect(rejected.body).toMatchObject({
      status: 'rejected',
      rejectionReason: 'El comprobante es ilegible.',
    });
    expect((await orderState(orderId)).status).toBe('payment_pending');
    const lapse = (await reservation(orderId)).expires_at!.getTime();
    // PAYMENT_REJECTION_GRACE_HOURS defaults to 4 (PROVISIONAL).
    expect(lapse).toBeGreaterThanOrEqual(before + 4 * 3_600_000 - 1000);
    expect(lapse).toBeLessThanOrEqual(Date.now() + 4 * 3_600_000 + 1000);

    // A new payment, with a new id, starts over.
    await initiate(buyer, orderId, first.id).expect(409);
    const second = await initiate(buyer, orderId).expect(201);
    expect(second.body.id).not.toBe(first.id);
    expect((await uploadProof(buyer, second.body.id)).body.status).toBe('proof_uploaded');
    expect(await reservation(orderId)).toEqual({ status: 'active', expires_at: null });
  });

  it('freezes a disputed payment and refunds it, leaving the ledger at zero', async () => {
    const { lotId } = await supplierWithLot(10);
    const buyer = await register('buyer');
    const finance = await staff('finance');
    const operator = await staff('operator');
    const orderId = await acceptedOrder(buyer, lotId, 2);
    const payment = (await initiate(buyer, orderId).expect(201)).body as { id: string };
    const confirmed = await uploadProof(buyer, payment.id);
    const verified = await http()
      .post(`/payments/${payment.id}/verify`)
      .set(bearer(finance))
      .send({ expectedVersion: confirmed.body.version })
      .expect(200);

    await http()
      .post(`/payments/${payment.id}/dispute`)
      .set(bearer(operator))
      .send({ expectedVersion: verified.body.version, reason: 'No llegó.' })
      .expect(404);
    const disputed = await http()
      .post(`/payments/${payment.id}/dispute`)
      .set(bearer(buyer))
      .send({ expectedVersion: verified.body.version, reason: 'No llegó.' })
      .expect(200);
    expect(disputed.body.status).toBe('disputed');
    expect((await orderState(orderId)).status).toBe('disputed');
    // A disputed order leaves logistics: no trip can take it.
    const carrier = await register('carrier');
    await http()
      .post('/logistics/carrier-profile')
      .set(bearer(carrier))
      .send({ vehicleType: 'Camion', capacityKg: 2000, plate: 'DSP001' })
      .expect(201);
    await http()
      .post('/logistics/trips')
      .set(bearer(carrier))
      .send({ id: createId(), orderIds: [orderId] })
      .expect(409);

    // Releasing is only for delivered orders; this one is refunded.
    await http()
      .post(`/payments/${payment.id}/dispute/resolve`)
      .set(bearer(operator))
      .send({ expectedVersion: disputed.body.version, outcome: 'release', note: 'ok' })
      .expect(409);
    const refunded = await http()
      .post(`/payments/${payment.id}/dispute/resolve`)
      .set(bearer(operator))
      .send({ expectedVersion: disputed.body.version, outcome: 'refund', note: 'Se devuelve.' })
      .expect(200);
    expect(refunded.body.status).toBe('refunded');
    expect((await orderState(orderId)).status).toBe('closed');
    expect(await ledgerBalance(orderId)).toEqual({});
  });

  it('answers 404 to another buyer disputing a payment, whatever version it sends', async () => {
    // Regression: the version was checked before the buyer, so a wrong version answered 409 and
    // revealed that someone else's payment exists.
    const { lotId } = await supplierWithLot(10);
    const buyer = await register('buyer');
    const intruder = await register('buyer');
    const finance = await staff('finance');
    const orderId = await acceptedOrder(buyer, lotId, 2);
    const payment = (await initiate(buyer, orderId).expect(201)).body as { id: string };
    const confirmed = await uploadProof(buyer, payment.id);
    const verified = await http()
      .post(`/payments/${payment.id}/verify`)
      .set(bearer(finance))
      .send({ expectedVersion: confirmed.body.version })
      .expect(200);

    const missing = await http()
      .post(`/payments/${createId()}/dispute`)
      .set(bearer(intruder))
      .send({ expectedVersion: verified.body.version, reason: 'No llegó.' })
      .expect(404);
    for (const expectedVersion of [verified.body.version + 1, verified.body.version])
      await http()
        .post(`/payments/${payment.id}/dispute`)
        .set(bearer(intruder))
        .send({ expectedVersion, reason: 'No llegó.' })
        .expect(404)
        .expect(({ body }) => expect(body).toEqual(missing.body));
    // The owner's payment is untouched and the owner can still dispute it.
    await http()
      .post(`/payments/${payment.id}/dispute`)
      .set(bearer(buyer))
      .send({ expectedVersion: verified.body.version, reason: 'No llegó.' })
      .expect(200);
  });

  it('refuses a dispute once settlements were issued', async () => {
    const { lotId } = await supplierWithLot(10);
    const buyer = await register('buyer');
    const finance = await staff('finance');
    const orderId = await acceptedOrder(buyer, lotId, 2);
    const payment = (await initiate(buyer, orderId).expect(201)).body as { id: string };
    const confirmed = await uploadProof(buyer, payment.id);
    await http()
      .post(`/payments/${payment.id}/verify`)
      .set(bearer(finance))
      .send({ expectedVersion: confirmed.body.version })
      .expect(200);
    await deliver(orderId);
    await pool.query(
      `UPDATE payments.payments SET held_at = held_at - interval '49 hours' WHERE id = $1`,
      [payment.id],
    );
    await app.get<PaymentsMaintenanceApi>(PAYMENTS_MAINTENANCE).issueDueSettlements();
    const current = await http().get(`/payments/${payment.id}`).set(bearer(buyer)).expect(200);

    const refused = await http()
      .post(`/payments/${payment.id}/dispute`)
      .set(bearer(buyer))
      .send({ expectedVersion: current.body.version, reason: 'Tarde.' })
      .expect(409);
    expect(refused.body.code).toBe('settlement_issued');
  });

  it(
    'verifies a proof exactly once when two reviewers race, and lets verify or reject win, never both',
    async () => {
      const { lotId } = await supplierWithLot(100);
      const buyer = await register('buyer');
      const reviewers = [
        { sub: createId(), role: 'finance' },
        { sub: createId(), role: 'operator' },
      ];
      for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
        const orderId = await acceptedOrder(buyer, lotId, 1);
        const payment = (await initiate(buyer, orderId).expect(201)).body as { id: string };
        const version = (await uploadProof(buyer, payment.id)).body.version as number;

        const outcomes =
          iteration % 2 === 0
            ? await Promise.allSettled(
                reviewers.map((reviewer) => service.verify(reviewer, payment.id, version)),
              )
            : await Promise.allSettled([
                service.verify(reviewers[0]!, payment.id, version),
                service.reject(reviewers[1]!, payment.id, version, 'Ilegible'),
              ]);

        expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
        const loser = outcomes.find(({ status }) => status === 'rejected') as PromiseRejectedResult;
        expect(['version_conflict', 'invalid_transition']).toContain(
          (loser.reason as { code?: string }).code,
        );
        const posted = await pool.query(
          `SELECT kind FROM payments.ledger_transactions WHERE order_id = $1`,
          [orderId],
        );
        const status = (await orderState(orderId)).status;
        if (status === 'paid') expect(posted.rows).toEqual([{ kind: 'payment_verified' }]);
        else {
          expect(status).toBe('payment_pending');
          expect(posted.rows).toEqual([]);
        }
      }
    },
    CONCURRENCY_TEST_TIMEOUT_MS,
  );

  it(
    'opens one payment per order when the buyer submits twice at once',
    async () => {
      const { lotId } = await supplierWithLot(100);
      const buyer = await register('buyer');
      for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
        const orderId = await acceptedOrder(buyer, lotId, 1);
        const responses = await Promise.all([initiate(buyer, orderId), initiate(buyer, orderId)]);
        expect(responses.map(({ status }) => status).sort()).toEqual([200, 201]);
        expect(new Set(responses.map(({ body }) => body.id)).size).toBe(1);
        const open = await pool.query(
          `SELECT 1 FROM payments.payments WHERE order_id = $1 AND status <> 'rejected'`,
          [orderId],
        );
        expect(open.rowCount).toBe(1);
      }
    },
    CONCURRENCY_TEST_TIMEOUT_MS,
  );

  it('issues the settlements of a payment once when two settlement jobs run together', async () => {
    const { lotId } = await supplierWithLot(10);
    const buyer = await register('buyer');
    const finance = await staff('finance');
    const orderId = await acceptedOrder(buyer, lotId, 2);
    const payment = (await initiate(buyer, orderId).expect(201)).body as { id: string };
    const confirmed = await uploadProof(buyer, payment.id);
    await http()
      .post(`/payments/${payment.id}/verify`)
      .set(bearer(finance))
      .send({ expectedVersion: confirmed.body.version })
      .expect(200);
    await deliver(orderId);
    await pool.query(
      `UPDATE payments.payments SET held_at = held_at - interval '49 hours' WHERE id = $1`,
      [payment.id],
    );

    const maintenance = app.get<PaymentsMaintenanceApi>(PAYMENTS_MAINTENANCE);
    const counts = await Promise.all([
      maintenance.issueDueSettlements(),
      maintenance.issueDueSettlements(),
    ]);

    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(1);
    const settlements = await pool.query(
      `SELECT beneficiary_kind FROM payments.settlements WHERE payment_id = $1`,
      [payment.id],
    );
    expect(settlements.rows).toEqual([{ beneficiary_kind: 'producer' }]);
  });

  it('keeps the ledger immutable and balanced in the database itself', async () => {
    const { lotId } = await supplierWithLot(10);
    const buyer = await register('buyer');
    const finance = await staff('finance');
    const orderId = await acceptedOrder(buyer, lotId, 2);
    const payment = (await initiate(buyer, orderId).expect(201)).body as { id: string };
    const confirmed = await uploadProof(buyer, payment.id);
    await http()
      .post(`/payments/${payment.id}/verify`)
      .set(bearer(finance))
      .send({ expectedVersion: confirmed.body.version })
      .expect(200);

    await expect(
      pool.query(`UPDATE payments.ledger_entries SET debit = debit + 1 WHERE order_id = $1`, [
        orderId,
      ]),
    ).rejects.toMatchObject({ code: '23000' });
    await expect(
      pool.query(`DELETE FROM payments.ledger_entries WHERE order_id = $1`, [orderId]),
    ).rejects.toMatchObject({ code: '23000' });
    await expect(
      pool.query(`DELETE FROM payments.payment_events WHERE payment_id = $1`, [payment.id]),
    ).rejects.toMatchObject({ code: '23000' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const transactionId = createId();
      await client.query(
        `INSERT INTO payments.ledger_transactions (id, order_id, payment_id, kind, created_at)
         VALUES ($1, $2, $3, 'refund', now())`,
        [transactionId, orderId, payment.id],
      );
      await client.query(
        `INSERT INTO payments.ledger_entries (id, transaction_id, order_id, account, debit, credit, created_at)
         VALUES ($1, $2, $3, 'cash_held', 0, 100, now()), ($4, $2, $3, 'payable_buyer_funds', 99, 0, now())`,
        [createId(), transactionId, orderId, createId()],
      );
      await expect(client.query('COMMIT')).rejects.toMatchObject({ code: '23514' });
    } finally {
      client.release();
    }
    expect(await ledgerBalance(orderId)).toEqual({
      cash_held: '9000',
      payable_buyer_funds: '-9000',
    });
  });
});
