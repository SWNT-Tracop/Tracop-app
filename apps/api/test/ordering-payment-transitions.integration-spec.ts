import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { AppModule } from '../src/bootstrap/app.module.js';
import { OrderingService } from '../src/modules/ordering/application/ordering-service.js';
import { verifyOrderEventChain } from '../src/modules/ordering/domain/order-events.js';
import { DATABASE_POOL } from '../src/shared/infra/tokens.js';
import { describePostgres, resetPostgresFixtures } from './postgres-suite.js';

const ITERATIONS = 20;
const CONCURRENCY_TEST_TIMEOUT_MS = 120_000;

describePostgres('ordering payment transitions (PostgreSQL)', () => {
  let app: INestApplication;
  let pool: pg.Pool;
  let ordering: OrderingService;
  let productId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    pool = app.get(DATABASE_POOL) as pg.Pool;
    ordering = app.get(OrderingService);
  });

  beforeEach(async () => {
    await resetPostgresFixtures(pool);
    const categoryId = uuidv7();
    productId = uuidv7();
    await pool.query(
      `INSERT INTO catalog.categories (id, name, depth, created_at, updated_at)
       VALUES ($1, 'Tubérculos', 1, NOW(), NOW())`,
      [categoryId],
    );
    await pool.query(
      `INSERT INTO catalog.products (id, category_id, name, unit, search_text, attributes, created_at, updated_at)
       VALUES ($1, $2, 'Papa', 'kg', 'papa', '{}', NOW(), NOW())`,
      [productId, categoryId],
    );
  });

  afterAll(async () => {
    await app.close();
  });

  /** A lot of `quantityKg` and an order for all of it, accepted and waiting for payment. */
  const pendingPaymentOrder = async (quantityKg = 1) => {
    const lotId = uuidv7();
    const providerId = uuidv7();
    const buyerId = uuidv7();
    await pool.query(
      `INSERT INTO catalog.lots (id, provider_id, product_id, quantity, unit, unit_price, quality_grade,
         available_from, available_until, location_lat, location_lng, status, version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'kg', 5000, NULL, NOW(), NOW() + INTERVAL '7 days', 4.6, -74.1,
         'published', 1, NOW(), NOW())`,
      [lotId, providerId, productId, quantityKg],
    );
    const buyer = { sub: buyerId, role: 'buyer' };
    const created = await ordering.createOrder(buyer, {
      id: uuidv7(),
      buyerId,
      lines: [{ lotId, quantityMilli: BigInt(quantityKg * 1000) }],
      deliveryAddress: 'Calle sintética 1, Bogotá',
      deliveryWindow: null,
    });
    const accepted = await ordering.acceptQuote({
      actor: buyer,
      orderId: created.order.id,
      expectedVersion: created.order.version,
    });
    await ordering.startPayment(accepted.order.id, buyerId);
    return { orderId: accepted.order.id, lotId, buyerId };
  };

  const orderStatus = async (orderId: string) =>
    (
      await pool.query<{ status: string }>(`SELECT status FROM ordering.orders WHERE id = $1`, [
        orderId,
      ])
    ).rows[0]!.status;

  const reservation = async (orderId: string) =>
    (
      await pool.query<{ status: string; expires_at: Date | null }>(
        `SELECT status, expires_at FROM catalog.lot_reservations WHERE order_id = $1`,
        [orderId],
      )
    ).rows[0]!;

  it('keeps the hash chain valid through payment_pending, paid, disputed and closed', async () => {
    const { orderId, lotId, buyerId } = await pendingPaymentOrder();
    await ordering.holdStockForPaymentReview(orderId);
    await ordering.markPaid(orderId, uuidv7());
    await ordering.markDisputed(orderId, buyerId);
    await ordering.closeOrder(orderId, uuidv7());

    const events = await pool.query<{
      type: string;
      payload: string;
      prev_hash: string | null;
      hash: string;
    }>(
      `SELECT type, payload, prev_hash, hash FROM ordering.order_events
       WHERE order_id = $1 ORDER BY occurred_at, id`,
      [orderId],
    );
    expect(events.rows.map(({ type }) => type)).toEqual([
      'OrderRequested',
      'OrderQuoted',
      'OrderAccepted',
      'OrderPaymentPending',
      'OrderPaid',
      'OrderDisputed',
      'OrderClosed',
    ]);
    expect(
      verifyOrderEventChain(
        events.rows.map((row) => ({
          payload: JSON.parse(row.payload) as unknown,
          prevHash: row.prev_hash,
          hash: row.hash,
        })),
      ),
    ).toBe(true);
    expect(await reservation(orderId)).toEqual({ status: 'consumed', expires_at: null });
    const lot = await pool.query<{ status: string }>(
      `SELECT status FROM catalog.lots WHERE id = $1`,
      [lotId],
    );
    expect(lot.rows[0]!.status).toBe('sold_out');
  });

  it(
    'never cancels an order whose proof holds the reservation while the expiry job runs',
    async () => {
      for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
        const { orderId } = await pendingPaymentOrder();
        const { expires_at: expiresAt } = await reservation(orderId);
        // The job runs "after" the reservation lapsed while the proof arrives just before.
        const jobNow = new Date(expiresAt!.getTime() + 1000);

        const [hold, expired] = await Promise.allSettled([
          ordering.holdStockForPaymentReview(orderId),
          ordering.expireReservations(jobNow, 10),
        ]);
        expect(expired.status).toBe('fulfilled');

        const status = await orderStatus(orderId);
        const row = await reservation(orderId);
        if (hold.status === 'fulfilled') {
          expect(status).toBe('payment_pending');
          expect(row).toEqual({ status: 'active', expires_at: null });
          expect((expired as PromiseFulfilledResult<number>).value).toBe(0);
        } else {
          expect(['invalid_transition', 'reservation_expired']).toContain(
            (hold.reason as { code?: string }).code,
          );
          expect(status).toBe('cancelled');
          expect(row.status).toBe('released');
          expect((expired as PromiseFulfilledResult<number>).value).toBe(1);
        }
      }
    },
    CONCURRENCY_TEST_TIMEOUT_MS,
  );

  it(
    'pays an order exactly once when two verifications race',
    async () => {
      for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
        const { orderId } = await pendingPaymentOrder();
        await ordering.holdStockForPaymentReview(orderId);

        const results = await Promise.allSettled([
          ordering.markPaid(orderId, uuidv7()),
          ordering.markPaid(orderId, uuidv7()),
        ]);

        expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
        const rejected = results.find(
          ({ status }) => status === 'rejected',
        ) as PromiseRejectedResult;
        expect(rejected.reason).toMatchObject({ code: 'invalid_transition' });
        const paidEvents = await pool.query(
          `SELECT 1 FROM ordering.order_events WHERE order_id = $1 AND type = 'OrderPaid'`,
          [orderId],
        );
        expect(paidEvents.rowCount).toBe(1);
      }
    },
    CONCURRENCY_TEST_TIMEOUT_MS,
  );

  it('refuses to start a payment once the reservation lapsed', async () => {
    const lotId = uuidv7();
    const buyerId = uuidv7();
    await pool.query(
      `INSERT INTO catalog.lots (id, provider_id, product_id, quantity, unit, unit_price, quality_grade,
         available_from, available_until, location_lat, location_lng, status, version, created_at, updated_at)
       VALUES ($1, $2, $3, 1, 'kg', 5000, NULL, NOW(), NOW() + INTERVAL '7 days', 4.6, -74.1,
         'published', 1, NOW(), NOW())`,
      [lotId, uuidv7(), productId],
    );
    const buyer = { sub: buyerId, role: 'buyer' };
    const created = await ordering.createOrder(buyer, {
      id: uuidv7(),
      buyerId,
      lines: [{ lotId, quantityMilli: 1000n }],
      deliveryAddress: 'Calle sintética 2, Bogotá',
      deliveryWindow: null,
    });
    await ordering.acceptQuote({
      actor: buyer,
      orderId: created.order.id,
      expectedVersion: created.order.version,
    });
    await pool.query(
      `UPDATE catalog.lot_reservations SET expires_at = created_at WHERE order_id = $1`,
      [created.order.id],
    );

    await expect(ordering.startPayment(created.order.id, buyerId)).rejects.toMatchObject({
      code: 'reservation_expired',
    });
    expect(await orderStatus(created.order.id)).toBe('accepted');
  });
});
