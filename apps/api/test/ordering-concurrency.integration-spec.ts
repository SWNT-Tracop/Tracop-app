import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/bootstrap/app.module.js';
import { InMemoryOtpSender } from '../src/modules/identity/adapters/out/otp-senders.js';
import { OTP_SENDER } from '../src/modules/identity/ports/tokens.js';
import { DATABASE_POOL } from '../src/shared/infra/tokens.js';
import { createId } from '../src/shared/kernel/ids.js';
import { describePostgres, resetPostgresFixtures } from './postgres-suite.js';
import pg from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { OrderingService } from '../src/modules/ordering/application/ordering-service.js';
import {
  ORDERING_MAINTENANCE,
  type OrderingMaintenanceApi,
} from '../src/modules/ordering/index.js';

describePostgres('Ordering concurrency (20 iterations each)', () => {
  let app: INestApplication;
  let pool: pg.Pool;
  let otpSender: InMemoryOtpSender;
  let phoneCounter = 8000000;

  const newPhone = () => `300${String(phoneCounter++).padStart(7, '0')}`;

  const registerBuyer = async () => {
    const phone = newPhone();
    const deviceId = createId();
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        phone,
        role: 'buyer',
        fullName: `Buyer ${phone}`,
        deviceId,
        platform: 'web',
        consent: { accepted: true, version: 'v0-draft' },
      })
      .expect(201);
    const code = otpSender.sent.at(-1)?.code;
    const verified = await request(app.getHttpServer())
      .post('/auth/otp/verify')
      .send({ phone, deviceId, platform: 'web', code });
    expect(verified.status).toBe(201);
    return {
      token: verified.body.accessToken as string,
      userId: verified.body.user.id as string,
      phone: `+57${phone}`,
    };
  };

  const registerSupplier = async () => {
    const phone = newPhone();
    const deviceId = createId();
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        phone,
        role: 'supplier',
        fullName: `Supplier ${phone}`,
        deviceId,
        platform: 'web',
        consent: { accepted: true, version: 'v0-draft' },
      })
      .expect(201);
    const code = otpSender.sent.at(-1)?.code;
    const verified = await request(app.getHttpServer())
      .post('/auth/otp/verify')
      .send({ phone, deviceId, platform: 'web', code });
    expect(verified.status).toBe(201);
    return {
      token: verified.body.accessToken as string,
      userId: verified.body.user.id as string,
      phone: `+57${phone}`,
    };
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
    await resetPostgresFixtures(pool);

    // Create category and product once
    const catId = uuidv7();
    const prodId = uuidv7();

    await pool.query(
      `
      INSERT INTO catalog.categories (id, name, depth, created_at, updated_at)
      VALUES ($1, 'Test Category', 1, NOW(), NOW())
    `,
      [catId],
    );

    await pool.query(
      `
      INSERT INTO catalog.products (id, category_id, name, unit, search_text, attributes, created_at, updated_at)
      VALUES ($1, $2, 'Test Product', 'kg', 'test product', '{}', NOW(), NOW())
    `,
      [prodId, catId],
    );

    // Store for test use
    (global as any).__TEST_CAT_ID__ = catId;
    (global as any).__TEST_PROD_ID__ = prodId;
  });

  beforeEach(async () => {
    phoneCounter = 8000000;
    otpSender.sent.length = 0;
    // Truncate identity tables including rate limit counters
    await pool.query(
      `TRUNCATE identity.provider_profiles, identity.consents, identity.otp_codes, identity.sessions, identity.devices, identity.channel_links, identity.users, identity.rate_limit_counters CASCADE`,
    );
  });

  afterAll(async () => {
    await app.close();
  });

  const resetLot = async (lotId: string, quantity: number) => {
    await pool.query(
      `UPDATE catalog.lots SET quantity = $1, status = 'published', version = 1 WHERE id = $2`,
      [quantity, lotId],
    );
    await pool.query(`DELETE FROM catalog.lot_reservations WHERE lot_id = $1`, [lotId]);
    await pool.query(`DELETE FROM sync.change_log WHERE entity = 'lot' AND entity_id = $1::uuid`, [
      lotId,
    ]);
    await pool.query(`DELETE FROM shared.outbox_events WHERE aggregate = $1`, [`lot:${lotId}`]);
    await pool.query(`TRUNCATE identity.rate_limit_counters CASCADE`);
  };

  const createLot = async (
    providerId: string,
    productId: string,
    quantityKg: number,
  ): Promise<string> => {
    const lotId = uuidv7();
    await pool.query(
      `INSERT INTO catalog.lots
       (id, provider_id, product_id, quantity, unit, unit_price, quality_grade,
        available_from, available_until, location_lat, location_lng, status, version, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'kg',5000,'Primera',NOW(),NOW()+INTERVAL '7 days',4.6,-74.1,'published',1,NOW(),NOW())`,
      [lotId, providerId, productId, quantityKg],
    );
    return lotId;
  };

  it('1) allows exactly one buyer for the last stock in 20 iterations', async () => {
    const supplier = await registerSupplier();
    const buyer1 = await registerBuyer();
    const buyer2 = await registerBuyer();
    const lotId = await createLot(supplier.userId, (global as any).__TEST_PROD_ID__, 1);

    for (let i = 0; i < 20; i += 1) {
      await resetLot(lotId, 1);
      const order1 = uuidv7();
      const order2 = uuidv7();
      await Promise.all([
        request(app.getHttpServer())
          .post('/orders')
          .set('Authorization', `Bearer ${buyer1.token}`)
          .send({
            id: order1,
            lines: [{ lotId, quantityMilli: '1000' }],
            deliveryAddress: 'Addr 1',
          }),
        request(app.getHttpServer())
          .post('/orders')
          .set('Authorization', `Bearer ${buyer2.token}`)
          .send({
            id: order2,
            lines: [{ lotId, quantityMilli: '1000' }],
            deliveryAddress: 'Addr 2',
          }),
      ]);
      const versions = await pool.query(
        `SELECT id, version FROM ordering.orders WHERE id IN ($1::uuid,$2::uuid)`,
        [order1, order2],
      );
      const accepted = await Promise.all(
        versions.rows.map((row: { id: string; version: number }) =>
          request(app.getHttpServer())
            .post(`/orders/${row.id}/accept`)
            .set('Authorization', `Bearer ${row.id === order1 ? buyer1.token : buyer2.token}`)
            .send({ expectedVersion: row.version }),
        ),
      );
      expect(accepted.filter((res) => res.status === 200)).toHaveLength(1);
      expect(accepted.filter((res) => res.status === 409)).toHaveLength(1);
      await pool.query(`DELETE FROM ordering.orders WHERE id IN ($1::uuid,$2::uuid)`, [
        order1,
        order2,
      ]);
    }
  }, 120000);

  it('2) handles inverse multilines without deadlock in 20 iterations', async () => {
    const supplier = await registerSupplier();
    const buyer1 = await registerBuyer();
    const buyer2 = await registerBuyer();
    const lotA = await createLot(supplier.userId, (global as any).__TEST_PROD_ID__, 2);
    const lotB = await createLot(supplier.userId, (global as any).__TEST_PROD_ID__, 2);

    for (let i = 0; i < 20; i += 1) {
      await resetLot(lotA, 2);
      await resetLot(lotB, 2);
      const orderA = uuidv7();
      const orderB = uuidv7();
      await Promise.all([
        request(app.getHttpServer())
          .post('/orders')
          .set('Authorization', `Bearer ${buyer1.token}`)
          .send({
            id: orderA,
            lines: [
              { lotId: lotA, quantityMilli: '2000' },
              { lotId: lotB, quantityMilli: '2000' },
            ],
            deliveryAddress: 'Addr A',
          }),
        request(app.getHttpServer())
          .post('/orders')
          .set('Authorization', `Bearer ${buyer2.token}`)
          .send({
            id: orderB,
            lines: [
              { lotId: lotB, quantityMilli: '2000' },
              { lotId: lotA, quantityMilli: '2000' },
            ],
            deliveryAddress: 'Addr B',
          }),
      ]);
      const versions = await pool.query(
        `SELECT id, version FROM ordering.orders WHERE id IN ($1::uuid,$2::uuid)`,
        [orderA, orderB],
      );
      const accepted = await Promise.all(
        versions.rows.map((row: { id: string; version: number }) =>
          request(app.getHttpServer())
            .post(`/orders/${row.id}/accept`)
            .set('Authorization', `Bearer ${row.id === orderA ? buyer1.token : buyer2.token}`)
            .send({ expectedVersion: row.version }),
        ),
      );
      expect(accepted.filter((res) => res.status === 200)).toHaveLength(1);
      expect(accepted.filter((res) => res.status === 409)).toHaveLength(1);
      await pool.query(`DELETE FROM ordering.orders WHERE id IN ($1::uuid,$2::uuid)`, [
        orderA,
        orderB,
      ]);
    }
  }, 120000);

  it('3) races accept, cancel and lazy expiration for 20 iterations', async () => {
    const supplier = await registerSupplier();
    const buyer = await registerBuyer();
    const lotId = await createLot(supplier.userId, (global as any).__TEST_PROD_ID__, 1);
    const ordering = app.get(OrderingService);

    for (let i = 0; i < 20; i += 1) {
      await resetLot(lotId, 1);
      const orderId = uuidv7();
      await request(app.getHttpServer())
        .post('/orders')
        .set('Authorization', `Bearer ${buyer.token}`)
        .send({
          id: orderId,
          lines: [{ lotId, quantityMilli: '1000' }],
          deliveryAddress: 'Addr race',
        })
        .expect(201);
      const row = await pool.query(`SELECT version FROM ordering.orders WHERE id=$1::uuid`, [
        orderId,
      ]);
      const version = row.rows[0].version as number;
      await Promise.allSettled([
        request(app.getHttpServer())
          .post(`/orders/${orderId}/accept`)
          .set('Authorization', `Bearer ${buyer.token}`)
          .send({ expectedVersion: version }),
        request(app.getHttpServer())
          .post(`/orders/${orderId}/cancel`)
          .set('Authorization', `Bearer ${buyer.token}`)
          .send({ expectedVersion: version }),
        ordering.expireReservation({ orderId, now: new Date() }),
      ]);
      await pool.query(`DELETE FROM ordering.orders WHERE id=$1::uuid`, [orderId]);
    }
  }, 120000);

  it('4) races provider quantity edit and acceptance for 20 iterations', async () => {
    const supplier = await registerSupplier();
    const buyer = await registerBuyer();
    const lotId = await createLot(supplier.userId, (global as any).__TEST_PROD_ID__, 5);

    for (let i = 0; i < 20; i += 1) {
      await resetLot(lotId, 5);
      const orderId = uuidv7();
      await request(app.getHttpServer())
        .post('/orders')
        .set('Authorization', `Bearer ${buyer.token}`)
        .send({
          id: orderId,
          lines: [{ lotId, quantityMilli: '1000' }],
          deliveryAddress: 'Addr edit',
        })
        .expect(201);
      const row = await pool.query(`SELECT version FROM ordering.orders WHERE id=$1::uuid`, [
        orderId,
      ]);
      await Promise.allSettled([
        request(app.getHttpServer())
          .post(`/orders/${orderId}/accept`)
          .set('Authorization', `Bearer ${buyer.token}`)
          .send({ expectedVersion: row.rows[0].version }),
        pool.query(
          `UPDATE catalog.lots SET quantity='4.500', version=version+1, updated_at=NOW() WHERE id=$1::uuid`,
          [lotId],
        ),
      ]);
      await pool.query(`DELETE FROM ordering.orders WHERE id=$1::uuid`, [orderId]);
    }
  }, 120000);

  it('5) deduplicates 20 concurrent creates with the same id', async () => {
    const supplier = await registerSupplier();
    const lotId = await createLot(supplier.userId, (global as any).__TEST_PROD_ID__, 1);

    for (let i = 0; i < 20; i += 1) {
      const buyer = await registerBuyer();
      await resetLot(lotId, 1);
      const orderId = uuidv7();
      const body = {
        id: orderId,
        lines: [{ lotId, quantityMilli: '1000' }],
        deliveryAddress: 'Addr duplicate',
      };
      const ordering = app.get(OrderingService);
      const responses = await Promise.allSettled(
        Array.from({ length: 20 }, () =>
          ordering.createOrder(
            { sub: buyer.userId, role: 'buyer' },
            {
              id: body.id,
              buyerId: buyer.userId,
              lines: body.lines.map((line) => ({
                lotId: line.lotId,
                quantityMilli: BigInt(line.quantityMilli),
              })),
              deliveryAddress: body.deliveryAddress,
              deliveryWindow: null,
            },
          ),
        ),
      );
      const fulfilled = responses.filter((res) => res.status === 'fulfilled');
      if (fulfilled.length !== 20)
        throw new Error(
          `duplicate-create reasons: ${JSON.stringify(
            responses
              .filter((res) => res.status === 'rejected')
              .map((res) => (res.status === 'rejected' ? res.reason : null))
              .slice(0, 3),
          )}`,
        );
      const count = await pool.query(`SELECT count(*) FROM ordering.orders WHERE id=$1::uuid`, [
        orderId,
      ]);
      expect(Number(count.rows[0].count)).toBe(1);
      await pool.query(`DELETE FROM ordering.orders WHERE id=$1::uuid`, [orderId]);
    }
  }, 120000);

  it('expires lazy reservations and is idempotent', async () => {
    const supplier = await registerSupplier();
    const buyer = await registerBuyer();
    const lotId = await createLot(supplier.userId, (global as any).__TEST_PROD_ID__, 1);
    const orderId = uuidv7();
    await request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${buyer.token}`)
      .send({
        id: orderId,
        lines: [{ lotId, quantityMilli: '1000' }],
        deliveryAddress: 'Addr expire',
      })
      .expect(201);
    await pool.query(
      `INSERT INTO catalog.lot_reservations
       (id,lot_id,order_id,quantity_milli,status,expires_at,created_at,updated_at)
       VALUES ($1,$2,$3,'1000','active',NOW()-INTERVAL '1 second',NOW()-INTERVAL '1 hour',NOW())`,
      [uuidv7(), lotId, orderId],
    );
    await pool.query(`UPDATE catalog.lots SET status='reserved', version=2 WHERE id=$1::uuid`, [
      lotId,
    ]);
    const ordering = app.get(OrderingService);
    const now = new Date();
    expect(await ordering.expireReservations(now, 100)).toBe(1);
    expect(await ordering.expireReservations(now, 100)).toBe(0);
  }, 120000);

  it('persists the quote status when the order is accepted or cancelled', async () => {
    const supplier = await registerSupplier();
    const buyer = await registerBuyer();
    const quoteStatus = async (orderId: string) =>
      (
        await pool.query<{ status: string }>(
          `SELECT status FROM ordering.quotes WHERE order_id = $1`,
          [orderId],
        )
      ).rows[0]?.status;
    const place = async () => {
      const lotId = await createLot(supplier.userId, (global as any).__TEST_PROD_ID__, 5);
      const orderId = uuidv7();
      await request(app.getHttpServer())
        .post('/orders')
        .set('Authorization', `Bearer ${buyer.token}`)
        .send({ id: orderId, lines: [{ lotId, quantityMilli: '1000' }], deliveryAddress: 'Addr' })
        .expect(201);
      const { rows } = await pool.query<{ version: number }>(
        `SELECT version FROM ordering.orders WHERE id = $1`,
        [orderId],
      );
      return { orderId, version: rows[0]!.version };
    };

    const accepted = await place();
    expect(await quoteStatus(accepted.orderId)).toBe('active');
    await request(app.getHttpServer())
      .post(`/orders/${accepted.orderId}/accept`)
      .set('Authorization', `Bearer ${buyer.token}`)
      .send({ expectedVersion: accepted.version })
      .expect(200);
    expect(await quoteStatus(accepted.orderId)).toBe('accepted');

    const cancelled = await place();
    await request(app.getHttpServer())
      .post(`/orders/${cancelled.orderId}/cancel`)
      .set('Authorization', `Bearer ${buyer.token}`)
      .send({ expectedVersion: cancelled.version })
      .expect(200);
    expect(await quoteStatus(cancelled.orderId)).toBe('cancelled');
  }, 120000);

  it('expires each overdue quote once when two expiry jobs run in parallel', async () => {
    const supplier = await registerSupplier();
    const buyer = await registerBuyer();
    const maintenance = app.get<OrderingMaintenanceApi>(ORDERING_MAINTENANCE);
    for (let iteration = 0; iteration < 20; iteration += 1) {
      const lotId = await createLot(supplier.userId, (global as any).__TEST_PROD_ID__, 1);
      const orderId = uuidv7();
      await request(app.getHttpServer())
        .post('/orders')
        .set('Authorization', `Bearer ${buyer.token}`)
        .send({ id: orderId, lines: [{ lotId, quantityMilli: '1000' }], deliveryAddress: 'Addr' })
        .expect(201);
      await pool.query(
        `UPDATE ordering.quotes SET valid_until = NOW() - INTERVAL '1 minute' WHERE order_id = $1`,
        [orderId],
      );
      const [first, second] = await Promise.all([
        maintenance.expireReservationsAndQuotes(),
        maintenance.expireReservationsAndQuotes(),
      ]);
      const state = await pool.query<{ status: string; quote: string; cancelled: string }>(
        `SELECT o.status, q.status AS quote,
                (SELECT count(*) FROM ordering.order_events e
                 WHERE e.order_id = o.id AND e.type = 'OrderCancelled')::text AS cancelled
         FROM ordering.orders o JOIN ordering.quotes q ON q.order_id = o.id
         WHERE o.id = $1`,
        [orderId],
      );
      expect({ iteration, expired: first.quotes + second.quotes, ...state.rows[0] }).toEqual({
        iteration,
        expired: 1,
        status: 'cancelled',
        quote: 'expired',
        cancelled: '1',
      });
    }
  }, 120000);

  it('cancels unpaid accepted orders once their reservation expires, never paid ones', async () => {
    const supplier = await registerSupplier();
    const buyer = await registerBuyer();
    const ordering = app.get(OrderingService);
    const acceptOrder = async () => {
      const lotId = await createLot(supplier.userId, (global as any).__TEST_PROD_ID__, 5);
      const orderId = uuidv7();
      await request(app.getHttpServer())
        .post('/orders')
        .set('Authorization', `Bearer ${buyer.token}`)
        .send({ id: orderId, lines: [{ lotId, quantityMilli: '1000' }], deliveryAddress: 'Addr' })
        .expect(201);
      const { rows } = await pool.query<{ version: number }>(
        `SELECT version FROM ordering.orders WHERE id = $1`,
        [orderId],
      );
      await request(app.getHttpServer())
        .post(`/orders/${orderId}/accept`)
        .set('Authorization', `Bearer ${buyer.token}`)
        .send({ expectedVersion: rows[0]!.version })
        .expect(200);
      await pool.query(
        `UPDATE catalog.lot_reservations
         SET created_at = NOW() - INTERVAL '2 hours', expires_at = NOW() - INTERVAL '1 minute'
         WHERE order_id = $1`,
        [orderId],
      );
      return orderId;
    };
    const state = async (orderId: string) =>
      (
        await pool.query<{
          status: string;
          reason: string | null;
          reservations: string;
          cancelled: string;
        }>(
          `SELECT o.status, o.cancel_reason AS reason,
                  (SELECT string_agg(r.status, ',') FROM catalog.lot_reservations r
                   WHERE r.order_id = o.id) AS reservations,
                  (SELECT count(*) FROM ordering.order_events e
                   WHERE e.order_id = o.id AND e.type = 'OrderCancelled')::text AS cancelled
           FROM ordering.orders o WHERE o.id = $1`,
          [orderId],
        )
      ).rows[0];

    for (let iteration = 0; iteration < 20; iteration += 1) {
      const orderId = await acceptOrder();
      const [first, second] = await Promise.all([
        ordering.expireReservations(new Date(), 100),
        ordering.expireReservations(new Date(), 100),
      ]);
      expect({ iteration, expired: first + second, ...(await state(orderId)) }).toEqual({
        iteration,
        expired: 1,
        status: 'cancelled',
        reason: 'reservation_expired',
        reservations: 'released',
        cancelled: '1',
      });
    }

    const pending = await acceptOrder();
    await pool.query(`UPDATE ordering.orders SET status = 'payment_pending' WHERE id = $1`, [
      pending,
    ]);
    expect(await ordering.expireReservations(new Date(), 100)).toBe(1);
    expect(await state(pending)).toMatchObject({
      status: 'cancelled',
      reason: 'reservation_expired',
    });

    const paid = await acceptOrder();
    await pool.query(`UPDATE ordering.orders SET status = 'paid' WHERE id = $1`, [paid]);
    expect(await ordering.expireReservations(new Date(), 100)).toBe(0);
    expect(await state(paid)).toMatchObject({
      status: 'paid',
      reservations: 'active',
      cancelled: '0',
    });
  }, 180000);
});
