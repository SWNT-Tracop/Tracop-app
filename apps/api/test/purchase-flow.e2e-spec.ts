import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import request from 'supertest';
import { AppModule } from '../src/bootstrap/app.module.js';
import { InMemoryOtpSender } from '../src/modules/identity/adapters/out/otp-senders.js';
import { OTP_SENDER } from '../src/modules/identity/ports/tokens.js';
import {
  ORDERING_MAINTENANCE,
  type OrderingMaintenanceApi,
} from '../src/modules/ordering/index.js';
import { DATABASE_POOL } from '../src/shared/infra/tokens.js';
import { createId } from '../src/shared/kernel/ids.js';
import { findCoordinateExposure } from './helpers/coordinate-exposure.js';
import { describePostgres, resetPostgresFixtures } from './postgres-suite.js';

const CONCURRENCY_TEST_TIMEOUT_MS = 180_000;
type Account = { readonly token: string; readonly userId: string };

describePostgres('purchase flow over HTTP (Nest + PostgreSQL)', () => {
  let app: INestApplication;
  let pool: pg.Pool;
  let otpSender: InMemoryOtpSender;
  let phoneSequence = 1;
  let productId: string;

  const http = () => request(app.getHttpServer());
  const bearer = (account: Account) => ({ Authorization: `Bearer ${account.token}` });

  const register = async (
    role: 'buyer' | 'producer' | 'supplier' | 'carrier',
  ): Promise<Account> => {
    const phone = `304${String(phoneSequence++).padStart(7, '0')}`;
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

  const publishLot = async (provider: Account, quantityKg: number): Promise<string> => {
    const id = createId();
    await http()
      .post('/lots')
      .set(bearer(provider))
      .send({
        id,
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
    await http().post(`/lots/${id}/publish`).set(bearer(provider)).send({ version: 1 }).expect(201);
    return id;
  };

  const placeOrder = async (buyer: Account, lotId: string, quantityKg: number) => {
    const id = createId();
    const created = await http()
      .post('/orders')
      .set(bearer(buyer))
      .send({
        id,
        lines: [{ lotId, quantityMilli: String(quantityKg * 1000) }],
        deliveryAddress: 'Calle 1 # 2-3, Chapinero, Bogotá',
      });
    return { id, response: created };
  };

  const accept = (buyer: Account, orderId: string, version: number) =>
    http().post(`/orders/${orderId}/accept`).set(bearer(buyer)).send({ expectedVersion: version });

  const lotView = async (viewer: Account, lotId: string) =>
    (await http().get(`/lots/${lotId}`).set(bearer(viewer)).expect(200)).body as {
      status: string;
      availableQuantityMilli: string;
    };

  const reservationStatuses = async (orderId: string) =>
    (
      await pool.query<{ status: string }>(
        `SELECT status FROM catalog.lot_reservations WHERE order_id = $1 ORDER BY status`,
        [orderId],
      )
    ).rows.map((row) => row.status);

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
    await resetPostgresFixtures(pool);
    otpSender.sent.length = 0;
    phoneSequence = 1;
    // The taxonomy is curated by staff; it is seeded directly so the test focuses on the purchase.
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

  it(
    'runs create, accept, sell out, cancel, reservation expiry and quote expiry end to end',
    async () => {
      const supplier = await register('supplier');
      const buyer = await register('buyer');
      const otherBuyer = await register('buyer');
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
      const lotId = await publishLot(supplier, 10);

      // Buyers find the lot without its exact location or the provider id.
      const search = await http().get('/lots').set(bearer(buyer)).expect(200);
      expect(search.body.items.map((item: { id: string }) => item.id)).toEqual([lotId]);
      expect(findCoordinateExposure(search.body, [{ latitude: 5.53, longitude: -73.36 }])).toEqual(
        [],
      );
      expect(search.body.items[0]).not.toHaveProperty('providerId');

      // 1. A quoted order does not reserve stock yet.
      const orderA = await placeOrder(buyer, lotId, 3);
      expect(orderA.response.status).toBe(201);
      expect(orderA.response.body).toMatchObject({ status: 'quoted', total: expect.any(String) });
      expect(await lotView(buyer, lotId)).toMatchObject({
        status: 'published',
        availableQuantityMilli: '10000',
      });

      // 2. Accepting reserves the quantity (partial purchase).
      await accept(buyer, orderA.id, orderA.response.body.version).expect(200);
      expect(await reservationStatuses(orderA.id)).toEqual(['active']);
      expect(await lotView(buyer, lotId)).toMatchObject({ availableQuantityMilli: '7000' });

      // 3. A second buyer takes the rest: the lot becomes reserved and further orders are refused.
      const orderB = await placeOrder(otherBuyer, lotId, 7);
      await accept(otherBuyer, orderB.id, orderB.response.body.version).expect(200);
      // A fully reserved lot leaves the public catalog: buyers get 404, its owner still sees it.
      await http().get(`/lots/${lotId}`).set(bearer(buyer)).expect(404);
      expect(await lotView(supplier, lotId)).toMatchObject({
        status: 'reserved',
        availableQuantityMilli: '0',
      });
      const refused = await placeOrder(buyer, lotId, 1);
      expect(refused.response.status).toBe(409);

      // 4. The provider sees accepted orders without the buyer's address or identity.
      const incoming = await http().get('/orders/incoming').set(bearer(supplier)).expect(200);
      expect(incoming.body.items.map((item: { id: string }) => item.id).sort()).toEqual(
        [orderA.id, orderB.id].sort(),
      );
      for (const item of incoming.body.items) {
        expect(item).not.toHaveProperty('deliveryAddress');
        expect(item).not.toHaveProperty('buyerId');
      }
      // A third party gets 404, not 403.
      await http().get(`/orders/${orderA.id}`).set(bearer(otherBuyer)).expect(404);

      // 5. The buyer cancels: the reservation is released and the lot is published again.
      const acceptedA = await http().get(`/orders/${orderA.id}`).set(bearer(buyer)).expect(200);
      await http()
        .post(`/orders/${orderA.id}/cancel`)
        .set(bearer(buyer))
        .send({ expectedVersion: acceptedA.body.version })
        .expect(200);
      expect(await reservationStatuses(orderA.id)).toEqual(['released']);
      expect(await lotView(buyer, lotId)).toMatchObject({
        status: 'published',
        availableQuantityMilli: '3000',
      });

      // 6. B is never paid: its reservation lapses and the expiry job cancels it.
      await pool.query(
        `UPDATE catalog.lot_reservations
       SET created_at = now() - interval '2 days', expires_at = now() - interval '1 minute'
       WHERE order_id = $1`,
        [orderB.id],
      );
      const maintenance = app.get<OrderingMaintenanceApi>(ORDERING_MAINTENANCE);
      expect(await maintenance.expireReservationsAndQuotes()).toMatchObject({ reservations: 1 });
      expect(
        (await http().get(`/orders/${orderB.id}`).set(bearer(otherBuyer)).expect(200)).body,
      ).toMatchObject({ status: 'cancelled', cancelReason: 'reservation_expired' });
      expect(await reservationStatuses(orderB.id)).toEqual(['released']);
      expect(await lotView(buyer, lotId)).toMatchObject({ availableQuantityMilli: '10000' });

      // 7. A quote nobody accepts expires.
      const orderC = await placeOrder(buyer, lotId, 2);
      await pool.query(
        `UPDATE ordering.quotes SET valid_until = now() - interval '1 minute' WHERE order_id = $1`,
        [orderC.id],
      );
      expect(await maintenance.expireReservationsAndQuotes()).toMatchObject({ quotes: 1 });
      expect(
        (await http().get(`/orders/${orderC.id}`).set(bearer(buyer)).expect(200)).body,
      ).toMatchObject({ status: 'cancelled', cancelReason: 'expired' });

      // 8. Every order keeps an unbroken hash chain of events.
      for (const orderId of [orderA.id, orderB.id, orderC.id]) {
        const events = (
          await pool.query<{ type: string; prev_hash: string | null; hash: string }>(
            `SELECT type, prev_hash, hash FROM ordering.order_events
           WHERE order_id = $1 ORDER BY occurred_at, id`,
            [orderId],
          )
        ).rows;
        expect(events[0]!.prev_hash).toBeNull();
        for (let index = 1; index < events.length; index += 1)
          expect(events[index]!.prev_hash).toBe(events[index - 1]!.hash);
        expect(events.at(-1)!.type).toBe('OrderCancelled');
      }
    },
    CONCURRENCY_TEST_TIMEOUT_MS,
  );

  it(
    'assigns a paid order to exactly one of two trips created at the same time',
    async () => {
      const supplier = await register('supplier');
      const buyer = await register('buyer');
      const carriers = [await register('carrier'), await register('carrier')];
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
      for (const [index, carrier] of carriers.entries())
        await http()
          .post('/logistics/carrier-profile')
          .set(bearer(carrier))
          .send({ vehicleType: 'Camion', capacityKg: 2000, plate: `TRK00${index}` })
          .expect(201);
      const lotId = await publishLot(supplier, 100);

      const loserOutcomes = new Set<string>();
      for (let iteration = 0; iteration < 20; iteration += 1) {
        const order = await placeOrder(buyer, lotId, 1);
        await accept(buyer, order.id, order.response.body.version).expect(200);
        // Payments is not implemented yet; the paid state is simulated, as in logistics.e2e-spec.
        await pool.query(
          `UPDATE ordering.orders SET status = 'paid', version = version + 1 WHERE id = $1`,
          [order.id],
        );
        const responses = await Promise.all(
          carriers.map((carrier) =>
            http()
              .post('/logistics/trips')
              .set(bearer(carrier))
              .send({ id: createId(), orderIds: [order.id] }),
          ),
        );
        const stops = await pool.query<{ trips: string; stops: string }>(
          `SELECT count(DISTINCT trip_id)::text AS trips, count(*)::text AS stops
         FROM logistics.trip_stops WHERE order_id = $1`,
          [order.id],
        );
        const state = await pool.query<{ status: string; scheduled: string }>(
          `SELECT o.status,
                (SELECT count(*) FROM ordering.order_events e
                 WHERE e.order_id = o.id AND e.type = 'OrderPickupScheduled')::text AS scheduled
         FROM ordering.orders o WHERE o.id = $1`,
          [order.id],
        );
        const losers = responses.filter((response) => response.status !== 201);
        for (const loser of losers) loserOutcomes.add(`${loser.status} ${loser.body?.code}`);
        expect({
          iteration,
          winners: responses.filter((response) => response.status === 201).length,
          losersRejectedAsClientErrors: losers.every(
            (response) => response.status >= 400 && response.status < 500,
          ),
          ...stops.rows[0],
          ...state.rows[0],
        }).toEqual({
          iteration,
          winners: 1,
          losersRejectedAsClientErrors: true,
          trips: '1',
          stops: '2',
          status: 'pickup_scheduled',
          scheduled: '1',
        });
      }
      // Reported by the audit: which domain error the losing request gets.
      process.stdout.write(`createTrip loser responses: ${[...loserOutcomes].join(' | ')}\n`);
    },
    CONCURRENCY_TEST_TIMEOUT_MS,
  );

  it('answers 409 with a stable code when a trip cannot take an order', async () => {
    const supplier = await register('supplier');
    const buyer = await register('buyer');
    const [first, second] = [await register('carrier'), await register('carrier')];
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
    for (const [index, carrier] of [first, second].entries())
      await http()
        .post('/logistics/carrier-profile')
        .set(bearer(carrier))
        .send({ vehicleType: 'Camion', capacityKg: 2000, plate: `TRK10${index}` })
        .expect(201);
    const lotId = await publishLot(supplier, 10);
    const order = await placeOrder(buyer, lotId, 1);
    await accept(buyer, order.id, order.response.body.version).expect(200);
    const createTrip = (carrier: Account) =>
      http()
        .post('/logistics/trips')
        .set(bearer(carrier))
        .send({ id: createId(), orderIds: [order.id] });

    // Accepted but not paid yet.
    const unpaid = await createTrip(first);
    expect({ status: unpaid.status, code: unpaid.body.code }).toEqual({
      status: 409,
      code: 'invalid_order_status',
    });

    await pool.query(
      `UPDATE ordering.orders SET status = 'paid', version = version + 1 WHERE id = $1`,
      [order.id],
    );
    await createTrip(first).expect(201);
    // The order already has stops in a trip; reported as such even if it reads as paid again.
    await pool.query(
      `UPDATE ordering.orders SET status = 'paid', version = version + 1 WHERE id = $1`,
      [order.id],
    );
    const taken = await createTrip(second);
    expect({ status: taken.status, code: taken.body.code }).toEqual({
      status: 409,
      code: 'assignment_conflict',
    });
  });

  it("lets only the order's buyer accept its quote", async () => {
    const supplier = await register('supplier');
    const buyer = await register('buyer');
    const otherBuyer = await register('buyer');
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
    const lotId = await publishLot(supplier, 10);
    const order = await placeOrder(buyer, lotId, 4);
    const version = order.response.body.version as number;

    // A third party (another buyer) and the provider get 404 and change nothing.
    for (const intruder of [otherBuyer, supplier]) {
      const attempt = await accept(intruder, order.id, version);
      expect({ status: attempt.status, code: attempt.body.code }).toEqual({
        status: 404,
        code: 'not_found',
      });
    }
    expect(await reservationStatuses(order.id)).toEqual([]);
    const unchanged = await http().get(`/orders/${order.id}`).set(bearer(buyer)).expect(200);
    expect(unchanged.body).toMatchObject({ status: 'quoted', version });

    // A third party cannot cancel either, and learns nothing even with a wrong version.
    for (const expectedVersion of [version, version + 7]) {
      const cancel = await http()
        .post(`/orders/${order.id}/cancel`)
        .set(bearer(otherBuyer))
        .send({ expectedVersion });
      expect({ status: cancel.status, code: cancel.body.code }).toEqual({
        status: 404,
        code: 'not_found',
      });
    }

    await accept(buyer, order.id, version).expect(200);
    expect(await reservationStatuses(order.id)).toEqual(['active']);
  });

  it('answers 409 with a stable code for state conflicts', async () => {
    const supplier = await register('supplier');
    const buyer = await register('buyer');
    const carrier = await register('carrier');
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
    await http()
      .post('/logistics/carrier-profile')
      .set(bearer(carrier))
      .send({ vehicleType: 'Camion', capacityKg: 2000, plate: 'TRK200' })
      .expect(201);
    const outcome = (response: request.Response) => ({
      status: response.status,
      code: response.body.code,
    });
    const conflict = (code: string) => ({ status: 409, code });

    // quote_expired: accepting after the quote's validity.
    const lotId = await publishLot(supplier, 10);
    const late = await placeOrder(buyer, lotId, 1);
    await pool.query(
      `UPDATE ordering.quotes SET valid_until = now() - interval '1 minute' WHERE order_id = $1`,
      [late.id],
    );
    expect(outcome(await accept(buyer, late.id, late.response.body.version))).toEqual(
      conflict('quote_expired'),
    );

    // invalid_transition (lot): publishing a lot that is already published.
    expect(
      outcome(
        await http().post(`/lots/${lotId}/publish`).set(bearer(supplier)).send({ version: 2 }),
      ),
    ).toEqual(conflict('invalid_transition'));

    // lot_unavailable: the provider cancels the lot before the buyer accepts.
    const pending = await placeOrder(buyer, lotId, 1);
    await http()
      .post(`/lots/${lotId}/cancel`)
      .set(bearer(supplier))
      .send({ version: 2 })
      .expect(201);
    expect(outcome(await accept(buyer, pending.id, pending.response.body.version))).toEqual(
      conflict('lot_unavailable'),
    );

    // invalid_transition (order): a paid order can no longer be cancelled.
    const lotForTrip = await publishLot(supplier, 10);
    const paid = await placeOrder(buyer, lotForTrip, 1);
    await accept(buyer, paid.id, paid.response.body.version).expect(200);
    await pool.query(
      `UPDATE ordering.orders SET status = 'paid', version = version + 1 WHERE id = $1`,
      [paid.id],
    );
    const paidVersion = (await http().get(`/orders/${paid.id}`).set(bearer(buyer)).expect(200)).body
      .version as number;
    expect(
      outcome(
        await http()
          .post(`/orders/${paid.id}/cancel`)
          .set(bearer(buyer))
          .send({ expectedVersion: paidVersion }),
      ),
    ).toEqual(conflict('invalid_transition'));

    // invalid_transition (trip): starting a trip that is already in progress.
    const trip = await http()
      .post('/logistics/trips')
      .set(bearer(carrier))
      .send({ id: createId(), orderIds: [paid.id] })
      .expect(201);
    const started = await http()
      .post(`/logistics/trips/${trip.body.id}/start`)
      .set(bearer(carrier))
      .send({ expectedVersion: trip.body.version })
      .expect(200);
    expect(
      outcome(
        await http()
          .post(`/logistics/trips/${trip.body.id}/start`)
          .set(bearer(carrier))
          .send({ expectedVersion: started.body.version }),
      ),
    ).toEqual(conflict('invalid_transition'));
  });
});
