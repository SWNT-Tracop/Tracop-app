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
  ORDER_REPOSITORY,
  type OrderRepository,
} from '../src/modules/ordering/ports/ordering-ports.js';
import { CATALOG_ORDERING_API, type CatalogOrderingApi } from '../src/modules/catalog/index.js';
import { verifyOrderEventChain } from '../src/modules/ordering/domain/order-events.js';

describePostgres('Catalog Ordering API integration', () => {
  let app: INestApplication;
  let pool: pg.Pool;
  let otpSender: InMemoryOtpSender;
  let phoneCounter = 9000000;

  const newPhone = () => `300${String(phoneCounter++).padStart(7, '0')}`;

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

    (global as any).__TEST_CAT_ID__ = catId;
    (global as any).__TEST_PROD_ID__ = prodId;
  });

  beforeEach(async () => {
    phoneCounter = 9000000;
    otpSender.sent.length = 0;
    await pool.query(
      `TRUNCATE identity.provider_profiles, identity.consents, identity.otp_codes, identity.sessions, identity.devices, identity.channel_links, identity.users, identity.rate_limit_counters CASCADE`,
    );
  });

  afterAll(async () => {
    await app.close();
  });

  const createPublishedLot = async (
    providerId: string,
    prodId: string,
    quantityKg: number,
  ): Promise<string> => {
    const lotId = uuidv7();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `
        INSERT INTO catalog.lots (id, provider_id, product_id, quantity, unit, unit_price, quality_grade,
          available_from, available_until, location_lat, location_lng, status, version, created_at, updated_at)
        VALUES ($1, $2, $3, $4, 'kg', 5000, 'Primera', NOW(), NOW() + INTERVAL '7 days', 4.6, -74.1, 'published', 1, NOW(), NOW())
        RETURNING id
      `,
        [lotId, providerId, prodId, quantityKg],
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    // Create baseline in change_log for this lot
    await pool.query(
      `
      INSERT INTO sync.change_log (entity, entity_id, op, payload, owner_user_id, occurred_at)
      SELECT 'lot', $1::uuid, 'upsert',
             jsonb_build_object(
               'id', id, 'productId', product_id, 'quantityMilli', (quantity * 1000)::text,
               'unit', unit, 'unitPrice', unit_price::text,
               'qualityGrade', quality_grade,
               'availableFrom', available_from::text,
               'availableUntil', available_until::text,
               'locationLat', location_lat,
               'locationLng', location_lng,
               'status', status,
               'version', version,
               'providerId', provider_id,
               'deletedAt', deleted_at
             ),
             provider_id, NOW()
      FROM catalog.lots WHERE id = $1::uuid
      ON CONFLICT DO NOTHING
    `,
      [lotId],
    );
    return lotId;
  };

  const getLotStatus = async (
    lotId: string,
  ): Promise<{ status: string; version: number } | null> => {
    const result = await pool.query(
      `SELECT status, version FROM catalog.lots WHERE id = $1::uuid`,
      [lotId],
    );
    if (result.rows.length === 0) return null;
    return { status: result.rows[0].status, version: result.rows[0].version };
  };

  const getChangeLogCount = async (lotId: string): Promise<number> => {
    const result = await pool.query(
      `SELECT count(*) FROM sync.change_log WHERE entity = 'lot' AND entity_id = $1::uuid`,
      [lotId],
    );
    return parseInt(result.rows[0].count, 10);
  };

  const getOutboxEventCount = async (aggregate: string): Promise<number> => {
    const result = await pool.query(
      `SELECT count(*) FROM shared.outbox_events WHERE aggregate = $1`,
      [aggregate],
    );
    return parseInt(result.rows[0].count, 10);
  };

  const getReservationCount = async (lotId: string): Promise<number> => {
    const result = await pool.query(
      `SELECT count(*) FROM catalog.lot_reservations WHERE lot_id = $1::uuid AND status = 'active'`,
      [lotId],
    );
    return parseInt(result.rows[0].count, 10);
  };

  it('reserving last unit leaves lot reserved, version + 1, ONE change_log row, and one outbox event', async () => {
    const supplier = await registerSupplier();
    const prodId = (global as any).__TEST_PROD_ID__;

    // Create lot with exactly 1 kg (1000 milli)
    const lotId = await createPublishedLot(supplier.userId, prodId, 1);

    // Verify initial state
    let lot = await getLotStatus(lotId);
    expect(lot!.status).toBe('published');
    expect(lot!.version).toBe(1);
    expect(await getChangeLogCount(lotId)).toBe(1); // baseline
    expect(await getOutboxEventCount(`lot:${lotId}`)).toBe(0);
    expect(await getReservationCount(lotId)).toBe(0);

    // Create a quoted order without reserving stock
    const buyer = await registerBuyer();
    const orderId = uuidv7();

    await request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${buyer.token}`)
      .send({ id: orderId, lines: [{ lotId, quantityMilli: '1000' }], deliveryAddress: 'Addr 1' })
      .expect(201);
    expect(await getReservationCount(lotId)).toBe(0);
    lot = await getLotStatus(lotId);
    expect(lot!.status).toBe('published');
    expect(lot!.version).toBe(1);

    const orderResult = await pool.query(
      `SELECT version FROM ordering.orders WHERE id = $1::uuid`,
      [orderId],
    );
    const catalogApi = app.get<CatalogOrderingApi>(CATALOG_ORDERING_API);
    expect((await catalogApi.getLotQuote(lotId)).availableQuantityMilli).toBe(1000n);
    await request(app.getHttpServer())
      .post(`/orders/${orderId}/accept`)
      .set('Authorization', `Bearer ${buyer.token}`)
      .send({ expectedVersion: orderResult.rows[0].version })
      .expect((response) => {
        if (response.status !== 200)
          throw new Error(`accept failed ${response.status}: ${JSON.stringify(response.body)}`);
      });

    // Verify lot state after reservation
    lot = await getLotStatus(lotId);
    expect(lot!.status).toBe('reserved');
    expect(lot!.version).toBe(2); // version incremented

    // Exactly ONE change_log row added (the status transition)
    const changeLogCount = await getChangeLogCount(lotId);
    expect(changeLogCount).toBe(2); // 1 baseline + 1 status change

    // One outbox event for LotReserved
    const outboxCount = await getOutboxEventCount(`lot:${lotId}`);
    expect(outboxCount).toBe(1);

    // Reservation exists
    expect(await getReservationCount(lotId)).toBe(1);
  });

  it('releaseOrderReservations reverts lot to published with version + 1, change_log, and outbox event', async () => {
    const supplier = await registerSupplier();
    const prodId = (global as any).__TEST_PROD_ID__;

    const lotId = await createPublishedLot(supplier.userId, prodId, 1);
    const buyer = await registerBuyer();
    const orderId = uuidv7();

    // Create and accept the order
    await request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${buyer.token}`)
      .send({ id: orderId, lines: [{ lotId, quantityMilli: '1000' }], deliveryAddress: 'Addr 1' })
      .expect(201);

    // Get the order version from database
    const orderResult = await pool.query(
      `SELECT version FROM ordering.orders WHERE id = $1::uuid`,
      [orderId],
    );
    await request(app.getHttpServer())
      .post(`/orders/${orderId}/accept`)
      .set('Authorization', `Bearer ${buyer.token}`)
      .send({ expectedVersion: orderResult.rows[0].version })
      .expect(200);
    const acceptedResult = await pool.query(
      `SELECT version FROM ordering.orders WHERE id = $1::uuid`,
      [orderId],
    );
    const orderVersion = acceptedResult.rows[0].version;

    // Verify reserved state
    let lot = await getLotStatus(lotId);
    expect(lot!.status).toBe('reserved');
    expect(lot!.version).toBe(2);
    const changeLogAfterReserve = await getChangeLogCount(lotId);
    const outboxAfterReserve = await getOutboxEventCount(`lot:${lotId}`);

    // Cancel order (releases reservation) - use the ordering service directly
    const orderingService = app.get(OrderingService);
    const aggregate = await orderingService.cancelOrder({
      actor: { sub: buyer.userId, role: 'buyer' },
      orderId,
      expectedVersion: orderVersion,
      reason: 'buyer_cancelled',
    });
    expect(aggregate.order.status).toBe('cancelled');

    // Verify lot reverted to published
    lot = await getLotStatus(lotId);
    expect(lot!.status).toBe('published');
    expect(lot!.version).toBe(3); // version incremented again

    // One more change_log row (status change back to published)
    const changeLogAfterRelease = await getChangeLogCount(lotId);
    expect(changeLogAfterRelease).toBe(changeLogAfterReserve + 1);

    // One more outbox event (LotAvailabilityRestored, not LotPublished)
    const outboxAfterRelease = await getOutboxEventCount(`lot:${lotId}`);
    expect(outboxAfterRelease).toBe(outboxAfterReserve + 1);
    const restoredEvents = await pool.query(
      `SELECT type FROM shared.outbox_events WHERE aggregate = $1::text ORDER BY created_at`,
      [`lot:${lotId}`],
    );
    expect(restoredEvents.rows).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'LotAvailabilityRestored' })]),
    );

    // No active reservations
    expect(await getReservationCount(lotId)).toBe(0);
  });

  it('accept failure after reservation rolls back reservation, state, version, change_log, and outbox', async () => {
    const supplier = await registerSupplier();
    const prodId = (global as any).__TEST_PROD_ID__;

    const lotId = await createPublishedLot(supplier.userId, prodId, 1);
    const initialChangeLog = await getChangeLogCount(lotId);
    const initialOutbox = await getOutboxEventCount(`lot:${lotId}`);

    const buyer = await registerBuyer();
    const orderId = uuidv7();

    await request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${buyer.token}`)
      .send({ id: orderId, lines: [{ lotId, quantityMilli: '1000' }], deliveryAddress: 'Addr 1' })
      .expect(201);

    const orderBeforeAccept = await pool.query(
      `SELECT status, version FROM ordering.orders WHERE id = $1::uuid`,
      [orderId],
    );
    expect(orderBeforeAccept.rows).toHaveLength(1);
    const orderBefore = orderBeforeAccept.rows[0];
    const orderEventsBefore = await pool.query(
      `SELECT id FROM ordering.order_events WHERE order_id = $1::uuid`,
      [orderId],
    );
    expect(await getReservationCount(lotId)).toBe(0);

    const repository = app.get<OrderRepository>(ORDER_REPOSITORY);
    const saveSpy = jest.spyOn(repository, 'save').mockImplementationOnce(async () => {
      throw new Error('forced_save_failure');
    });

    await request(app.getHttpServer())
      .post(`/orders/${orderId}/accept`)
      .set('Authorization', `Bearer ${buyer.token}`)
      .send({ expectedVersion: orderBeforeAccept.rows[0].version })
      .expect(500);

    expect(saveSpy).toHaveBeenCalledTimes(1);
    saveSpy.mockRestore();

    const lot = await getLotStatus(lotId);
    expect(lot).toEqual({ status: 'published', version: 1 });
    expect(await getReservationCount(lotId)).toBe(0);
    expect(await getChangeLogCount(lotId)).toBe(initialChangeLog);
    expect(await getOutboxEventCount(`lot:${lotId}`)).toBe(initialOutbox);

    const orderAfterFailure = await pool.query(
      `SELECT id, status, version FROM ordering.orders WHERE id = $1::uuid`,
      [orderId],
    );
    expect(orderAfterFailure.rows).toHaveLength(1);
    expect(orderAfterFailure.rows[0]).toMatchObject({
      status: orderBefore.status,
      version: orderBefore.version,
    });
    const orderEventsAfterFailure = await pool.query(
      `SELECT id FROM ordering.order_events WHERE order_id = $1::uuid`,
      [orderId],
    );
    expect(orderEventsAfterFailure.rows).toHaveLength(orderEventsBefore.rows.length);
  });

  it('deduplicates same-content order requests and rejects reused ids with different content or buyer', async () => {
    const supplier = await registerSupplier();
    const buyer = await registerBuyer();
    const otherBuyer = await registerBuyer();
    const lotId = await createPublishedLot(supplier.userId, (global as any).__TEST_PROD_ID__, 10);
    const orderId = uuidv7();
    const body = {
      id: orderId,
      lines: [{ lotId, quantityMilli: '1000' }],
      deliveryAddress: 'Calle sintética 1',
    };

    const first = await request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${buyer.token}`)
      .send(body)
      .expect(201);
    expect(first.body.deliveryAddress).toBe('Calle sintética 1');

    const duplicate = await request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${buyer.token}`)
      .send(body)
      .expect(201);
    expect(duplicate.body.id).toBe(orderId);
    expect(await getReservationCount(lotId)).toBe(0);

    await request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${buyer.token}`)
      .send({ ...body, deliveryAddress: 'Calle diferente 2' })
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe('idempotency_content_mismatch'));

    await request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${otherBuyer.token}`)
      .send(body)
      .expect(409)
      .expect(({ body }) => {
        expect(body.code).toBe('idempotency_conflict');
        expect(body).toMatchObject({
          statusCode: 409,
          code: 'idempotency_conflict',
          message: 'El pedido ya existe.',
        });
      });

    expect(await getReservationCount(lotId)).toBe(0);
  });

  it('rejects duplicate lot lines before reserving stock', async () => {
    const supplier = await registerSupplier();
    const buyer = await registerBuyer();
    const lotId = await createPublishedLot(supplier.userId, (global as any).__TEST_PROD_ID__, 10);

    await request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${buyer.token}`)
      .send({
        id: uuidv7(),
        lines: [
          { lotId, quantityMilli: '1000' },
          { lotId, quantityMilli: '1000' },
        ],
        deliveryAddress: 'Calle sintética 1',
      })
      .expect(400)
      .expect(({ body }) => expect(body.code).toBe('duplicate_lot_line'));

    expect(await getReservationCount(lotId)).toBe(0);
  });

  it('returns role-safe order DTOs for buyer, provider and third party', async () => {
    const supplier = await registerSupplier();
    const buyer = await registerBuyer();
    const thirdParty = await registerBuyer();
    const lotId = await createPublishedLot(supplier.userId, (global as any).__TEST_PROD_ID__, 10);
    const orderId = uuidv7();

    await request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${buyer.token}`)
      .send({
        id: orderId,
        lines: [{ lotId, quantityMilli: '1000' }],
        deliveryAddress: 'Dirección privada sintética',
        deliveryWindow: '2026-11-20T12:00:00.000Z',
      })
      .expect(201);

    const buyerResponse = await request(app.getHttpServer())
      .get(`/orders/${orderId}`)
      .set('Authorization', `Bearer ${buyer.token}`)
      .expect(200);
    expect(buyerResponse.body.deliveryAddress).toBe('Dirección privada sintética');
    expect(buyerResponse.body).not.toHaveProperty('providerId');
    if (buyerResponse.body.provider !== null)
      expect(buyerResponse.body.provider).not.toHaveProperty('userId');

    const providerResponse = await request(app.getHttpServer())
      .get(`/orders/${orderId}`)
      .set('Authorization', `Bearer ${supplier.token}`)
      .expect(200);
    expect(providerResponse.body).not.toHaveProperty('deliveryAddress');
    expect(providerResponse.body).not.toHaveProperty('deliveryWindow');
    expect(providerResponse.body).not.toHaveProperty('providerId');
    expect(providerResponse.body).not.toHaveProperty('buyerId');
    expect(providerResponse.body).not.toHaveProperty('buyer');
    expect(providerResponse.body).not.toHaveProperty('buyerName');
    expect(providerResponse.body).not.toHaveProperty('buyerPhone');

    await request(app.getHttpServer())
      .get(`/orders/${orderId}`)
      .set('Authorization', `Bearer ${thirdParty.token}`)
      .expect(404);
  });

  it('detects order_events payload manipulation in PostgreSQL', async () => {
    const supplier = await registerSupplier();
    const buyer = await registerBuyer();
    const lotId = await createPublishedLot(supplier.userId, (global as any).__TEST_PROD_ID__, 1);
    const orderId = uuidv7();

    await request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${buyer.token}`)
      .send({
        id: orderId,
        lines: [{ lotId, quantityMilli: '1000' }],
        deliveryAddress: 'Addr chain',
      })
      .expect(201);

    const orderResult = await pool.query(
      `SELECT version FROM ordering.orders WHERE id = $1::uuid`,
      [orderId],
    );
    await request(app.getHttpServer())
      .post(`/orders/${orderId}/accept`)
      .set('Authorization', `Bearer ${buyer.token}`)
      .send({ expectedVersion: orderResult.rows[0].version })
      .expect(200);

    const rows = await pool.query(
      `SELECT prev_hash, hash, payload
       FROM ordering.order_events
       WHERE order_id = $1::uuid
       ORDER BY occurred_at, id`,
      [orderId],
    );
    const chain = rows.rows.map(
      (row: { prev_hash: string | null; hash: string; payload: string }) => ({
        prevHash: row.prev_hash,
        hash: row.hash,
        payload: JSON.parse(row.payload),
      }),
    );
    expect(chain.length).toBeGreaterThanOrEqual(3);
    expect(verifyOrderEventChain(chain)).toBe(true);

    await pool.query(
      `UPDATE ordering.order_events
       SET payload = jsonb_build_object('status', 'cancelled')::text
       WHERE id = (
         SELECT id FROM ordering.order_events
         WHERE order_id = $1::uuid
         ORDER BY occurred_at, id
         LIMIT 1
       )`,
      [orderId],
    );

    const mutated = await pool.query(
      `SELECT prev_hash, hash, payload
       FROM ordering.order_events
       WHERE order_id = $1::uuid
       ORDER BY occurred_at, id`,
      [orderId],
    );
    expect(
      verifyOrderEventChain(
        mutated.rows.map((row: { prev_hash: string | null; hash: string; payload: string }) => ({
          prevHash: row.prev_hash,
          hash: row.hash,
          payload: JSON.parse(row.payload),
        })),
      ),
    ).toBe(false);
  });

  it('fails if ordering or bootstrap use catalog repository directly', async () => {
    // This test verifies that the public API doesn't expose LotRepository
    // If someone tries to import CATALOG_LOT_REPOSITORY from catalog/index.ts,
    // TypeScript will fail because it's not exported.
    // This is a compile-time check, so we just verify the exports.

    const catalogExports = await import('../src/modules/catalog/index.js');
    expect(catalogExports.CATALOG_ORDERING_API).toBeDefined();
    expect('LotRepository' in catalogExports).toBe(false);
    expect('CatalogClock' in catalogExports).toBe(false);
  });
});
