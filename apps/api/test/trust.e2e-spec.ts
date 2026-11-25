import { Writable } from 'node:stream';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import request from 'supertest';
import { AppModule } from '../src/bootstrap/app.module.js';
import { InMemoryOtpSender } from '../src/modules/identity/adapters/out/otp-senders.js';
import { OTP_SENDER } from '../src/modules/identity/ports/tokens.js';
import {
  CarrierProfileService,
  CheckinService,
  TripPlanningService,
} from '../src/modules/logistics/index.js';
import { OrderingService } from '../src/modules/ordering/index.js';
import { PAYMENTS_SERVICE, type PaymentsService } from '../src/modules/payments/index.js';
import {
  TRUST_CLOCK,
  TRUST_OUTBOX_SUBSCRIBER,
  TRUST_SERVICE,
  type TrustService,
} from '../src/modules/trust/index.js';
import { nonChronologicalOrder } from '../src/modules/trust/domain/rating.js';
import { createLogger } from '../src/shared/infra/logger.js';
import { NestPinoLogger } from '../src/shared/infra/nest-pino-logger.js';
import { InMemoryStorageAdapter } from '../src/shared/infra/storage/in-memory-storage.adapter.js';
import { APP_LOGGER, DATABASE_POOL } from '../src/shared/infra/tokens.js';
import { createId } from '../src/shared/kernel/ids.js';
import type { OutboxSubscriberPort } from '../src/shared/ports/outbox-subscriber.js';
import { STORAGE_PORT } from '../src/shared/ports/storage.js';
import { createStaffAccount } from './helpers/staff-account.js';
import { createSyntheticJpeg } from './helpers/synthetic-image.js';
import { findTextExposure } from './helpers/text-exposure.js';
import { describePostgres, resetPostgresFixtures } from './postgres-suite.js';

type Account = { readonly token: string; readonly userId: string };
const CONCURRENCY_TEST_TIMEOUT_MS = 180_000;

/** The trust module's clock, moved by hand relative to the real delivery time. */
class ManualClock {
  private current = new Date();
  now(): Date {
    return new Date(this.current);
  }
  set(at: Date): void {
    this.current = new Date(at);
  }
}

describePostgres('trust: ratings, reputation and verification (Nest + PostgreSQL)', () => {
  let app: INestApplication;
  let pool: pg.Pool;
  let otpSender: InMemoryOtpSender;
  let clock: ManualClock;
  let logOutput = '';
  let phoneSequence = 1;
  let productId: string;

  const http = () => request(app.getHttpServer());
  const bearer = (account: Account) => ({ Authorization: `Bearer ${account.token}` });
  const nextPhone = () => `309${String(phoneSequence++).padStart(7, '0')}`;

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

  const withProviderProfile = async (supplier: Account) => {
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
  };

  const withCarrierProfile = async (carrier: Account) => {
    await app.get(CarrierProfileService).upsertMine(
      { sub: carrier.userId, role: 'carrier' },
      {
        vehicleType: 'Camion',
        capacityKg: 2000,
        plate: `TR${String(phoneSequence).padStart(4, '0')}`,
      },
    );
  };

  const insertLot = async (providerId: string) => {
    const lotId = createId();
    await pool.query(
      `INSERT INTO catalog.lots (id, provider_id, product_id, quantity, unit, unit_price, quality_grade,
         available_from, available_until, location_lat, location_lng, status, version, created_at, updated_at)
       VALUES ($1, $2, $3, 100, 'kg', 4500, NULL, NOW() - INTERVAL '1 hour', NOW() + INTERVAL '7 days',
         5.53, -73.36, 'published', 1, NOW(), NOW())`,
      [lotId, providerId, productId],
    );
    return lotId;
  };

  /**
   * A delivered order through the real use cases: accepted, paid with a verified proof (unless
   * `paid` is false: then it is only marked paid in ordering), picked up and delivered.
   * Returns the order id and its delivery time; the trust clock is set an hour after it.
   */
  const deliveredOrder = async (
    buyer: Account,
    supplier: Account,
    carrier: Account,
    lotId: string,
    options: { readonly paid?: boolean; readonly deliveryWindow?: string | null } = {},
  ) => {
    const ordering = app.get(OrderingService);
    const buyerActor = { sub: buyer.userId, role: 'buyer' };
    const created = await ordering.createOrder(buyerActor, {
      id: createId(),
      buyerId: buyer.userId,
      lines: [{ lotId, quantityMilli: 1000n }],
      deliveryAddress: 'Calle sintética 9, Bogotá',
      deliveryWindow: options.deliveryWindow ?? null,
    });
    const orderId = created.order.id;
    await ordering.acceptQuote({
      actor: buyerActor,
      orderId,
      expectedVersion: created.order.version,
    });
    if (options.paid === false) {
      await pool.query(
        `UPDATE ordering.orders SET status = 'paid', version = version + 1 WHERE id = $1`,
        [orderId],
      );
    } else {
      const payments = app.get<PaymentsService>(PAYMENTS_SERVICE);
      const initiated = await payments.initiate(buyerActor, {
        orderId,
        paymentId: createId(),
        method: 'transfer',
      });
      const paymentId = initiated.view.payment.id;
      const policy = await payments.requestProofUpload(buyerActor, paymentId);
      await (app.get(STORAGE_PORT) as InMemoryStorageAdapter).putObject({
        key: policy.fields.key!,
        body: await createSyntheticJpeg(),
        contentType: 'image/jpeg',
      });
      const proof = await payments.confirmProof(buyerActor, paymentId);
      await payments.verify({ sub: createId(), role: 'finance' }, paymentId, proof.payment.version);
    }
    const carrierActor = { sub: carrier.userId, role: 'carrier' };
    const trip = await app
      .get(TripPlanningService)
      .createTrip(carrierActor, { id: createId(), orderIds: [orderId] });
    const stops = await app.get(TripPlanningService).listStops(carrierActor, trip.id);
    for (const kind of ['pickup', 'delivery'] as const)
      await app.get(CheckinService).record(
        carrierActor,
        {
          id: createId(),
          stopId: stops.find((stop) => stop.kind === kind)!.id,
          kind,
          clientAt: new Date(),
        },
        trip.version,
      );
    const delivered = await pool.query<{ occurred_at: Date }>(
      `SELECT occurred_at FROM ordering.order_events WHERE order_id = $1 AND type = 'OrderDelivered'`,
      [orderId],
    );
    const deliveredAt = delivered.rows[0]!.occurred_at;
    clock.set(new Date(deliveredAt.getTime() + 3_600_000));
    return { orderId, deliveredAt };
  };

  const rate = (
    buyer: Account,
    orderId: string,
    ratee: 'provider' | 'carrier',
    score: number,
    comment?: string,
    id = createId(),
  ) =>
    http()
      .post('/trust/ratings')
      .set(bearer(buyer))
      .send({ id, orderId, ratee, score, ...(comment ? { comment } : {}) });

  const reputation = async (subjectId: string, kind: 'provider' | 'carrier') =>
    (
      await pool.query<{ rating_sum: string; ratings_count: number }>(
        `SELECT rating_sum::text, ratings_count FROM trust.reputations WHERE subject_id = $1 AND subject_kind = $2`,
        [subjectId, kind],
      )
    ).rows[0];

  beforeAll(async () => {
    const sender = new InMemoryOtpSender();
    clock = new ManualClock();
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        logOutput += chunk.toString();
        callback();
      },
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(OTP_SENDER)
      .useValue(sender)
      .overrideProvider(TRUST_CLOCK)
      .useValue(clock)
      .overrideProvider(APP_LOGGER)
      .useValue(createLogger('development', destination))
      .compile();
    app = moduleRef.createNestApplication();
    app.useLogger(new NestPinoLogger(app.get(APP_LOGGER)));
    await app.listen(0, '127.0.0.1');
    pool = app.get(DATABASE_POOL) as pg.Pool;
    otpSender = sender;
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

  const actors = async () => {
    const supplier = await register('supplier');
    const buyer = await register('buyer');
    const carrier = await register('carrier');
    await withProviderProfile(supplier);
    await withCarrierProfile(carrier);
    return { supplier, buyer, carrier, lotId: await insertLot(supplier.userId) };
  };

  it('lets the buyer rate the provider and the carrier once each, idempotently by id', async () => {
    const { supplier, buyer, carrier, lotId } = await actors();
    const { orderId } = await deliveredOrder(buyer, supplier, carrier, lotId);

    const ratingId = createId();
    const first = await rate(buyer, orderId, 'provider', 4, 'Buena papa', ratingId).expect(201);
    expect(first.body).toEqual({
      id: ratingId,
      ratee: 'provider',
      score: 4,
      comment: 'Buena papa',
    });
    await rate(buyer, orderId, 'provider', 4, 'Buena papa', ratingId).expect(200);
    const changed = await rate(buyer, orderId, 'provider', 5, 'Buena papa', ratingId).expect(409);
    const another = await rate(buyer, orderId, 'provider', 4).expect(409);
    expect([changed.body.code, another.body.code]).toEqual(['rating_conflict', 'rating_conflict']);
    expect(changed.body.message).toBe(another.body.message);
    await rate(buyer, orderId, 'carrier', 5).expect(201);

    expect(await reputation(supplier.userId, 'provider')).toEqual({
      rating_sum: '4',
      ratings_count: 1,
    });
    expect(await reputation(carrier.userId, 'carrier')).toEqual({
      rating_sum: '5',
      ratings_count: 1,
    });
    const events = await pool.query<{ type: string; payload: Record<string, unknown> }>(
      `SELECT type, payload FROM shared.outbox_events WHERE type = 'RatingSubmitted' ORDER BY created_at, id`,
    );
    expect(events.rows).toHaveLength(2);
    for (const { payload } of events.rows) {
      // The event names who was rated, never the buyer or the order.
      expect(Object.keys(payload).sort()).toEqual(['rateeId', 'rateeKind', 'ratingId', 'score']);
    }
  });

  it(
    'keeps one rating when the buyer submits two at once',
    async () => {
      const { supplier, buyer, carrier, lotId } = await actors();
      for (let iteration = 0; iteration < 10; iteration += 1) {
        const { orderId } = await deliveredOrder(buyer, supplier, carrier, lotId);
        const statuses = (
          await Promise.all([
            rate(buyer, orderId, 'carrier', 3),
            rate(buyer, orderId, 'carrier', 3),
          ])
        ).map(({ status }) => status);
        expect(statuses.sort()).toEqual([201, 409]);
      }
      expect(await reputation(carrier.userId, 'carrier')).toEqual({
        rating_sum: '30',
        ratings_count: 10,
      });
    },
    CONCURRENCY_TEST_TIMEOUT_MS,
  );

  it(
    'leaves exact totals after 20 concurrent ratings of one provider, then rate limits',
    async () => {
      const { supplier, carrier, lotId } = await actors();
      const buyer = await register('buyer');
      const orders = [];
      for (let index = 0; index < 20; index += 1)
        orders.push((await deliveredOrder(buyer, supplier, carrier, lotId)).orderId);
      const scores = orders.map((_, index) => (index % 5) + 1);

      const responses = await Promise.all(
        orders.map((orderId, index) => rate(buyer, orderId, 'provider', scores[index]!)),
      );

      expect(responses.map(({ status }) => status)).toEqual(orders.map(() => 201));
      expect(await reputation(supplier.userId, 'provider')).toEqual({
        rating_sum: String(scores.reduce((sum, score) => sum + score, 0)),
        ratings_count: 20,
      });
      // TRUST_RATING_RATE_LIMIT is 20 per window.
      const limited = await rate(buyer, orders[0]!, 'carrier', 5).expect(429);
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    },
    CONCURRENCY_TEST_TIMEOUT_MS,
  );

  it('answers 404 outside the window, without a verified payment, on another buyer order, and 403 to other roles', async () => {
    const { supplier, buyer, carrier, lotId } = await actors();
    const otherBuyer = await register('buyer');

    const unpaid = await deliveredOrder(buyer, supplier, carrier, lotId, { paid: false });
    await rate(buyer, unpaid.orderId, 'provider', 5).expect(404);

    const { orderId, deliveredAt } = await deliveredOrder(buyer, supplier, carrier, lotId);
    await rate(otherBuyer, orderId, 'provider', 5).expect(404);
    await http()
      .post('/trust/ratings')
      .set(bearer(supplier))
      .send({ id: createId(), orderId, ratee: 'provider', score: 5 })
      .expect(403);
    await rate(buyer, createId(), 'provider', 5).expect(404);

    // trust.rating_window_days = 7: one millisecond after it closes.
    clock.set(new Date(deliveredAt.getTime() + 7 * 86_400_000 + 1));
    await rate(buyer, orderId, 'provider', 5).expect(404);
    clock.set(new Date(deliveredAt.getTime() + 7 * 86_400_000));
    await rate(buyer, orderId, 'provider', 5).expect(201);
  });

  it('shows the average and comments only from three ratings, without order or date, in a non-chronological order', async () => {
    const { supplier, carrier, lotId } = await actors();
    const buyers = [await register('buyer'), await register('buyer'), await register('buyer')];
    const ids: string[] = [];
    const comments = ['Primera compra', 'Llegó bien', 'Repetiría'];
    for (const [index, buyer] of buyers.entries()) {
      const { orderId } = await deliveredOrder(buyer, supplier, carrier, lotId);
      const id = createId();
      ids.push(id);
      await rate(buyer, orderId, 'provider', [5, 4, 4][index]!, comments[index], id).expect(201);
      const mine = await http().get('/trust/me').set(bearer(supplier)).expect(200);
      if (index < 2) {
        expect(mine.body).toEqual({
          rating: null,
          ratingsCount: index + 1,
          comments: [],
          verification: 'unverified',
        });
      }
    }

    const mine = await http().get('/trust/me').set(bearer(supplier)).expect(200);
    expect(Object.keys(mine.body).sort()).toEqual([
      'comments',
      'rating',
      'ratingsCount',
      'verification',
    ]);
    expect(mine.body.rating).toBe('4.3');
    expect(mine.body.ratingsCount).toBe(3);
    // Texts only, nothing that ties a comment to an order, a buyer or a time.
    for (const comment of mine.body.comments) expect(typeof comment).toBe('string');
    const expectedOrder = nonChronologicalOrder(
      ids.map((id, index) => ({ id, comment: comments[index]! })),
    );
    expect(mine.body.comments).toEqual(expectedOrder.map(({ comment }) => comment));
    // The carrier's reputation is not shown to the provider; the carrier sees its own.
    const carrierView = await http().get('/trust/me').set(bearer(carrier)).expect(200);
    expect(carrierView.body.verification).toBeNull();
  });

  it('lets staff hide a comment: the score keeps counting and the action is audited', async () => {
    const { supplier, buyer, carrier, lotId } = await actors();
    const operator = await createStaffAccount(app, pool, 'operator', `+57${nextPhone()}`);
    const { orderId } = await deliveredOrder(buyer, supplier, carrier, lotId);
    const rated = await rate(buyer, orderId, 'provider', 2, 'Texto inapropiado').expect(201);

    await http().post(`/trust/staff/ratings/${rated.body.id}/hide`).set(bearer(buyer)).expect(403);
    const hidden = await http()
      .post(`/trust/staff/ratings/${rated.body.id}/hide`)
      .set(bearer(operator))
      .expect(200);
    expect(hidden.body).toEqual({ id: rated.body.id, ratee: 'provider', score: 2, comment: null });
    expect(await reputation(supplier.userId, 'provider')).toEqual({
      rating_sum: '2',
      ratings_count: 1,
    });
    const audit = await pool.query<{ action: string; actor_id: string }>(
      `SELECT action, actor_id FROM backoffice.audit_log WHERE entity_id = $1`,
      [rated.body.id],
    );
    expect(audit.rows).toEqual([{ action: 'rating.hide_comment', actor_id: operator.userId }]);
    const staffView = await http()
      .get(`/trust/staff/subjects/${supplier.userId}`)
      .set(bearer(operator))
      .expect(200);
    expect(staffView.body.ratings).toEqual([
      expect.objectContaining({ orderId, score: 2, hidden: true, comment: 'Texto inapropiado' }),
    ]);
  });

  it('runs the verification flow with checks, rejection with cooldown and revocation, all audited', async () => {
    const supplier = await register('supplier');
    const operator = await createStaffAccount(app, pool, 'operator', `+57${nextPhone()}`);
    const staff = (path: string, body: object) =>
      http()
        .post(`/trust/staff/verifications/${supplier.userId}/${path}`)
        .set(bearer(operator))
        .send(body);

    await http()
      .post('/trust/verification-requests')
      .set(bearer(supplier))
      .send({ note: 'Finca en Tunja' })
      .expect(201);
    const pending = await http()
      .get('/trust/staff/verifications')
      .set(bearer(operator))
      .expect(200);
    expect(pending.body.items.map(({ providerId }: { providerId: string }) => providerId)).toEqual([
      supplier.userId,
    ]);
    await http().get('/trust/staff/verifications').set(bearer(supplier)).expect(403);

    const incomplete = await staff('approve', {
      checks: { contact_confirmed: true, location_confirmed: false, reference_checked: true },
    }).expect(409);
    expect(incomplete.body.code).toBe('verification_checks_incomplete');
    await staff('reject', { reason: 'No respondió la llamada' }).expect(200);
    const tooSoon = await http()
      .post('/trust/verification-requests')
      .set(bearer(supplier))
      .send({})
      .expect(409);
    expect(tooSoon.body.code).toBe('verification_cooldown');

    // trust.verification_cooldown_days = 7.
    clock.set(new Date(clock.now().getTime() + 7 * 86_400_000));
    await http().post('/trust/verification-requests').set(bearer(supplier)).send({}).expect(201);
    await staff('approve', {
      checks: { contact_confirmed: true, location_confirmed: true, reference_checked: true },
    }).expect(200);
    expect(
      (await http().get('/trust/me').set(bearer(supplier)).expect(200)).body.verification,
    ).toBe('verified');
    await staff('revoke', { reason: 'Quejas confirmadas' }).expect(200);

    const audit = await pool.query<{
      action: string;
      before: { status: string };
      after: { status: string };
    }>(
      `SELECT action, before, after FROM backoffice.audit_log WHERE entity = 'verification' ORDER BY at, id`,
    );
    expect(
      audit.rows.map(({ action, before, after }) => [action, before.status, after.status]),
    ).toEqual([
      ['verification.request', 'unverified', 'pending'],
      ['verification.reject', 'pending', 'rejected'],
      ['verification.request', 'rejected', 'pending'],
      ['verification.approve', 'pending', 'verified'],
      ['verification.revoke', 'verified', 'revoked'],
    ]);
    const events = await pool.query<{ type: string }>(
      `SELECT type FROM shared.outbox_events WHERE aggregate = $1 ORDER BY created_at, id`,
      [`provider:${supplier.userId}`],
    );
    expect(events.rows.map(({ type }) => type)).toEqual([
      'VerificationRequested',
      'VerificationRejected',
      'VerificationRequested',
      'ProviderVerified',
      'VerificationRevoked',
    ]);
  });

  it('shows buyers the provider trust block without its id, with one batched lookup per page', async () => {
    const { supplier, buyer, carrier, lotId } = await actors();
    const other = await register('supplier');
    await withProviderProfile(other);
    const otherLot = await insertLot(other.userId);
    const operator = await createStaffAccount(app, pool, 'operator', `+57${nextPhone()}`);
    await http().post('/trust/verification-requests').set(bearer(supplier)).send({}).expect(201);
    await http()
      .post(`/trust/staff/verifications/${supplier.userId}/approve`)
      .set(bearer(operator))
      .send({
        checks: { contact_confirmed: true, location_confirmed: true, reference_checked: true },
      })
      .expect(200);
    const { orderId } = await deliveredOrder(buyer, supplier, carrier, lotId);
    await rate(buyer, orderId, 'provider', 5).expect(201);

    const trust = app.get<TrustService>(TRUST_SERVICE);
    const lookups = jest.spyOn(trust, 'providerTrust');
    const search = await http().get('/lots').set(bearer(buyer)).expect(200);
    expect(lookups).toHaveBeenCalledTimes(1);
    expect(new Set(lookups.mock.calls[0]![0])).toEqual(new Set([supplier.userId, other.userId]));
    lookups.mockRestore();

    const byLot = new Map(search.body.items.map((item: { id: string }) => [item.id, item]));
    expect((byLot.get(lotId) as { provider: unknown }).provider).toEqual({
      displayName: 'Finca sintética',
      municipality: 'Tunja',
      department: 'Boyacá',
      verified: true,
      rating: null, // one rating, below trust.min_ratings_visible
      ratingsCount: 1,
    });
    expect((byLot.get(otherLot) as { provider: { verified: boolean } }).provider.verified).toBe(
      false,
    );
    const detail = await http().get(`/lots/${lotId}`).set(bearer(buyer)).expect(200);
    const order = await http().get(`/orders/${orderId}`).set(bearer(buyer)).expect(200);
    const mine = await http().get('/orders/mine').set(bearer(buyer)).expect(200);
    for (const provider of [
      detail.body.provider,
      order.body.provider,
      mine.body.items[0].provider,
    ]) {
      expect(provider).toMatchObject({ verified: true, rating: null, ratingsCount: 1 });
      expect(Object.keys(provider).sort()).toEqual(
        ['department', 'displayName', 'municipality', 'ratingsCount', 'rating', 'verified'].sort(),
      );
    }
    for (const body of [search.body, detail.body, order.body, mine.body])
      expect(findTextExposure(body, [supplier.userId])).toEqual([]);
  });

  it('counts each delivery once for the carrier internal punctuality', async () => {
    const { supplier, buyer, carrier, lotId } = await actors();
    const operator = await createStaffAccount(app, pool, 'operator', `+57${nextPhone()}`);
    const onTime = await deliveredOrder(buyer, supplier, carrier, lotId, {
      deliveryWindow: new Date(Date.now() + 86_400_000).toISOString(),
    });
    await deliveredOrder(buyer, supplier, carrier, lotId, { deliveryWindow: null });

    const subscriber = app.get<OutboxSubscriberPort>(TRUST_OUTBOX_SUBSCRIBER);
    const events = await pool.query<{
      id: string;
      aggregate: string;
      type: string;
      payload: Record<string, unknown>;
      created_at: Date;
    }>(
      `SELECT id, aggregate, type, payload, created_at FROM shared.outbox_events WHERE type = 'OrderDelivered'`,
    );
    for (const row of events.rows) {
      const record = {
        id: row.id,
        aggregate: row.aggregate,
        type: row.type,
        payload: row.payload,
        createdAt: row.created_at,
        attempts: 0,
      };
      await subscriber.handle(record);
      await subscriber.handle(record); // at-least-once delivery
    }

    const view = await http()
      .get(`/trust/staff/subjects/${carrier.userId}`)
      .set(bearer(operator))
      .expect(200);
    expect(view.body.carrierDeliveries).toEqual({
      deliveredCount: 2,
      withWindowCount: 1,
      onTimeCount: 1,
    });
    expect(onTime.orderId).toEqual(expect.any(String));
    // Internal: neither the carrier nor anyone else sees it outside the staff view.
    const own = await http().get('/trust/me').set(bearer(carrier)).expect(200);
    expect(Object.keys(own.body).sort()).toEqual([
      'comments',
      'rating',
      'ratingsCount',
      'verification',
    ]);
    await http().get(`/trust/staff/subjects/${carrier.userId}`).set(bearer(carrier)).expect(403);
  });

  it('keeps rating comments out of the logs and the process output', async () => {
    const { supplier, buyer, carrier, lotId } = await actors();
    const { orderId } = await deliveredOrder(buyer, supplier, carrier, lotId);
    const secret = 'Comentario-marcador-7f3a';
    logOutput = '';
    let processOutput = '';
    const capture = (chunk: unknown) => {
      processOutput += String(chunk);
      return true;
    };
    const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(capture as never);
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(capture as never);
    try {
      await rate(buyer, orderId, 'provider', 3, secret).expect(201);
      await rate(buyer, orderId, 'provider', 3, secret).expect(409);
      await rate(buyer, orderId, 'carrier', 3, 'x'.repeat(501)).expect(400);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
    const entries = `${logOutput}\n${processOutput}`
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line) as unknown;
        } catch {
          return line;
        }
      });
    for (const entry of entries) expect(findTextExposure(entry, [secret])).toEqual([]);
  });
});
