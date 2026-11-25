import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { AppModule } from '../src/bootstrap/app.module.js';
import { CATALOG_ORDERING_API, type CatalogOrderingApi } from '../src/modules/catalog/index.js';
import { DATABASE_POOL } from '../src/shared/infra/tokens.js';
import { describePostgres, resetPostgresFixtures } from './postgres-suite.js';

const HOUR = 60 * 60 * 1000;

describePostgres('catalog reservations held during payment review', () => {
  let app: INestApplication;
  let pool: pg.Pool;
  let catalog: CatalogOrderingApi;
  let productId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    pool = app.get(DATABASE_POOL) as pg.Pool;
    catalog = app.get<CatalogOrderingApi>(CATALOG_ORDERING_API);
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

  const createLot = async (quantityKg: number): Promise<string> => {
    const lotId = uuidv7();
    await pool.query(
      `INSERT INTO catalog.lots (id, provider_id, product_id, quantity, unit, unit_price, quality_grade,
         available_from, available_until, location_lat, location_lng, status, version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'kg', 5000, NULL, NOW(), NOW() + INTERVAL '7 days', 4.6, -74.1,
         'published', 1, NOW(), NOW())`,
      [lotId, uuidv7(), productId, quantityKg],
    );
    return lotId;
  };

  const reserve = async (lotId: string, quantityMilli: bigint, expiresAt: Date) => {
    const orderId = uuidv7();
    await catalog.reserveLots({ orderId, lines: [{ lotId, quantityMilli }], expiresAt });
    return orderId;
  };

  const reservationRows = async (orderId: string) =>
    (
      await pool.query<{ status: string; expires_at: Date | null }>(
        `SELECT status, expires_at FROM catalog.lot_reservations WHERE order_id = $1`,
        [orderId],
      )
    ).rows;

  const lotState = async (lotId: string) =>
    (
      await pool.query<{ status: string; version: number }>(
        `SELECT status, version FROM catalog.lots WHERE id = $1`,
        [lotId],
      )
    ).rows[0];

  it('holds a live reservation: it no longer lapses and keeps subtracting stock', async () => {
    const lotId = await createLot(10);
    const orderId = await reserve(lotId, 4000n, new Date(Date.now() + HOUR));

    await catalog.holdOrderReservations(orderId);

    expect(await reservationRows(orderId)).toEqual([{ status: 'active', expires_at: null }]);
    const farFuture = new Date(Date.now() + 365 * 24 * HOUR);
    expect(await catalog.findExpiredReservationOrderIds(farFuture, 10)).toEqual([]);
    expect(await catalog.isOrderReservationExpired(orderId, farFuture)).toBe(false);
    expect((await catalog.getLotQuote(lotId)).availableQuantityMilli).toBe(6000n);
  });

  it('refuses to hold a reservation that already lapsed', async () => {
    const lotId = await createLot(10);
    const orderId = await reserve(lotId, 4000n, new Date(Date.now() + HOUR));
    await pool.query(
      `UPDATE catalog.lot_reservations SET expires_at = created_at WHERE order_id = $1`,
      [orderId],
    );

    await expect(catalog.holdOrderReservations(orderId)).rejects.toMatchObject({
      code: 'reservation_expired',
    });
    expect((await reservationRows(orderId))[0]!.expires_at).not.toBeNull();
  });

  it('refuses to hold a released reservation', async () => {
    const lotId = await createLot(10);
    const orderId = await reserve(lotId, 4000n, new Date(Date.now() + HOUR));
    await catalog.releaseOrderReservations(orderId);

    await expect(catalog.holdOrderReservations(orderId)).rejects.toMatchObject({
      code: 'reservation_expired',
    });
  });

  it('gives a held reservation a new expiry after a rejected proof', async () => {
    const lotId = await createLot(10);
    const orderId = await reserve(lotId, 4000n, new Date(Date.now() + HOUR));
    await catalog.holdOrderReservations(orderId);
    const graceEnd = new Date(Date.now() + 2 * HOUR);

    await catalog.resumeOrderReservationExpiry(orderId, graceEnd);

    const [row] = await reservationRows(orderId);
    expect(row!.expires_at?.toISOString()).toBe(graceEnd.toISOString());
    expect(await catalog.isOrderReservationExpired(orderId, new Date(graceEnd.getTime() + 1))).toBe(
      true,
    );
  });

  it('consumes a held reservation: stock stays subtracted and the lot keeps its state when stock remains', async () => {
    const lotId = await createLot(10);
    const orderId = await reserve(lotId, 4000n, new Date(Date.now() + HOUR));
    await catalog.holdOrderReservations(orderId);

    await catalog.consumeOrderReservations(orderId);

    expect(await reservationRows(orderId)).toEqual([{ status: 'consumed', expires_at: null }]);
    expect((await catalog.getLotQuote(lotId)).availableQuantityMilli).toBe(6000n);
    expect((await lotState(lotId))!.status).toBe('published');
  });

  it('marks the lot sold_out when its whole quantity is consumed, with event and sync change', async () => {
    const lotId = await createLot(1);
    const orderId = await reserve(lotId, 1000n, new Date(Date.now() + HOUR));
    expect((await lotState(lotId))!.status).toBe('reserved');
    await catalog.holdOrderReservations(orderId);

    await catalog.consumeOrderReservations(orderId);

    expect(await lotState(lotId)).toEqual({ status: 'sold_out', version: 3 });
    const events = await pool.query<{ type: string }>(
      `SELECT type FROM shared.outbox_events WHERE aggregate = $1 ORDER BY created_at, id`,
      [`lot:${lotId}`],
    );
    expect(events.rows.map(({ type }) => type)).toEqual(['LotReserved', 'LotSoldOut']);
    const changes = await pool.query<{ status: string }>(
      `SELECT payload->>'status' AS status FROM sync.change_log
       WHERE entity = 'lot' AND entity_id = $1 ORDER BY server_seq`,
      [lotId],
    );
    expect(changes.rows.at(-1)!.status).toBe('sold_out');
  });

  it('keeps a lot reserved while another order still holds part of it, and sold_out after both are consumed', async () => {
    const lotId = await createLot(2);
    const first = await reserve(lotId, 1000n, new Date(Date.now() + HOUR));
    const second = await reserve(lotId, 1000n, new Date(Date.now() + HOUR));
    await catalog.holdOrderReservations(first);
    await catalog.holdOrderReservations(second);

    await catalog.consumeOrderReservations(first);
    expect((await lotState(lotId))!.status).toBe('reserved');

    await catalog.consumeOrderReservations(second);
    expect((await lotState(lotId))!.status).toBe('sold_out');
  });

  it('refuses to consume a reservation that is not held', async () => {
    const lotId = await createLot(10);
    const orderId = await reserve(lotId, 4000n, new Date(Date.now() + HOUR));

    await expect(catalog.consumeOrderReservations(orderId)).rejects.toMatchObject({
      code: 'reservation_conflict',
    });
    expect(await reservationRows(orderId)).toEqual([
      { status: 'active', expires_at: expect.any(Date) },
    ]);
  });

  it('does not release stock of a consumed lot when another order is released', async () => {
    const lotId = await createLot(2);
    const sold = await reserve(lotId, 1000n, new Date(Date.now() + HOUR));
    const pending = await reserve(lotId, 1000n, new Date(Date.now() + HOUR));
    await catalog.holdOrderReservations(sold);
    await catalog.consumeOrderReservations(sold);

    await catalog.releaseOrderReservations(pending);

    expect((await catalog.getLotQuote(lotId)).availableQuantityMilli).toBe(1000n);
    expect((await lotState(lotId))!.status).toBe('published');
  });
});
