import { Writable } from 'node:stream';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import request from 'supertest';
import { AppModule } from '../src/bootstrap/app.module.js';
import { InMemoryOtpSender } from '../src/modules/identity/adapters/out/otp-senders.js';
import { OTP_SENDER } from '../src/modules/identity/ports/tokens.js';
import { NOTIFICATIONS_OUTBOX_SUBSCRIBER } from '../src/modules/notifications/index.js';
import { OrderingService } from '../src/modules/ordering/index.js';
import {
  RECOMMENDATIONS_CLOCK,
  RECOMMENDATIONS_OUTBOX_SUBSCRIBERS,
  RECOMMENDATIONS_SERVICE,
  type RecommendationsService,
} from '../src/modules/recommendations/index.js';
import { createLogger } from '../src/shared/infra/logger.js';
import { APP_LOGGER, DATABASE_POOL } from '../src/shared/infra/tokens.js';
import { createId } from '../src/shared/kernel/ids.js';
import type { OutboxSubscriberPort } from '../src/shared/ports/outbox-subscriber.js';
import { createStaffAccount } from './helpers/staff-account.js';
import { findCoordinateExposure } from './helpers/coordinate-exposure.js';
import { findTextExposure } from './helpers/text-exposure.js';
import { describePostgres, resetPostgresFixtures } from './postgres-suite.js';

type Account = { readonly token: string; readonly userId: string };
const NOW = new Date('2026-11-25T15:00:00.000Z');
const BOGOTA = { lat: 4.6533, lng: -74.0836 };
const TUNJA = { lat: 5.5353, lng: -73.3678 };
const HEADER = 'fecha,mercado,producto,presentacion,precio';

class FixedClock {
  now(): Date {
    return new Date(NOW);
  }
}

describePostgres(
  'recommendations: prices, lot recommendations and alerts (Nest + PostgreSQL)',
  () => {
    let app: INestApplication;
    let pool: pg.Pool;
    let otpSender: InMemoryOtpSender;
    let service: RecommendationsService;
    let logOutput = '';
    let phoneSequence = 1;
    let categoryId: string;
    let papaId: string;
    let tomateId: string;

    const http = () => request(app.getHttpServer());
    const bearer = (account: Account) => ({ Authorization: `Bearer ${account.token}` });
    const nextPhone = () => `311${String(phoneSequence++).padStart(7, '0')}`;

    const register = async (role: 'buyer' | 'supplier' | 'producer'): Promise<Account> => {
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
      const account = {
        token: verified.body.accessToken as string,
        userId: verified.body.user.id as string,
      };
      if (role !== 'buyer')
        await http()
          .put('/me/provider-profile')
          .set(bearer(account))
          .send({
            displayName: 'Finca',
            municipality: 'Tunja',
            department: 'Boyacá',
            ...TUNJA,
            description: 'Sintético',
          })
          .expect(200);
      return account;
    };

    const insertLot = async (
      providerId: string,
      productId: string,
      options: {
        price?: number;
        status?: string;
        at?: { lat: number; lng: number };
        from?: string;
      } = {},
    ) => {
      const lotId = createId();
      const at = options.at ?? TUNJA;
      await pool.query(
        `INSERT INTO catalog.lots (id, provider_id, product_id, quantity, unit, unit_price, quality_grade,
         available_from, available_until, location_lat, location_lng, status, version, created_at, updated_at)
       VALUES ($1, $2, $3, 100, 'bulto', $4, NULL, $5, NOW() + INTERVAL '20 days', $6, $7, $8, 1, NOW(), NOW())`,
        [
          lotId,
          providerId,
          productId,
          options.price ?? 90_000,
          options.from ?? '2026-11-01T00:00:00Z',
          at.lat,
          at.lng,
          options.status ?? 'published',
        ],
      );
      return lotId;
    };

    const subscribers = () =>
      app.get<readonly OutboxSubscriberPort[]>(RECOMMENDATIONS_OUTBOX_SUBSCRIBERS);
    /** Delivers the pending outbox events of the given types to the recommendations consumers. */
    const deliver = async (types: readonly string[], consumers = subscribers()) => {
      const events = await pool.query<{
        id: string;
        aggregate: string;
        type: string;
        payload: Record<string, unknown>;
        created_at: Date;
      }>(
        `SELECT id, aggregate, type, payload, created_at FROM shared.outbox_events WHERE type = ANY($1) ORDER BY created_at, id`,
        [types],
      );
      for (const row of events.rows)
        for (const consumer of consumers)
          if (consumer.eventTypes === '*' || consumer.eventTypes.includes(row.type))
            await consumer.handle({
              id: row.id,
              aggregate: row.aggregate,
              type: row.type,
              payload: row.payload,
              createdAt: row.created_at,
              attempts: 0,
            });
      return events.rows.length;
    };

    const acceptedOrder = async (buyer: Account, lotId: string) => {
      const ordering = app.get(OrderingService);
      const actor = { sub: buyer.userId, role: 'buyer' };
      const created = await ordering.createOrder(actor, {
        id: createId(),
        buyerId: buyer.userId,
        lines: [{ lotId, quantityMilli: 1000n }],
        deliveryAddress: 'Calle sintética 1, Bogotá',
        deliveryWindow: null,
      });
      await ordering.acceptQuote({
        actor,
        orderId: created.order.id,
        expectedVersion: created.order.version,
      });
      return created.order.id;
    };

    const csv = (...rows: string[]) => [HEADER, ...rows].join('\n');

    beforeAll(async () => {
      otpSender = new InMemoryOtpSender();
      const destination = new Writable({
        write(chunk, _encoding, callback) {
          logOutput += chunk.toString();
          callback();
        },
      });
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(OTP_SENDER)
        .useValue(otpSender)
        .overrideProvider(RECOMMENDATIONS_CLOCK)
        .useValue(new FixedClock())
        .overrideProvider(APP_LOGGER)
        .useValue(createLogger('development', destination))
        .compile();
      app = moduleRef.createNestApplication();
      await app.listen(0, '127.0.0.1');
      pool = app.get(DATABASE_POOL) as pg.Pool;
      service = app.get<RecommendationsService>(RECOMMENDATIONS_SERVICE);
    });

    afterAll(async () => app?.close());

    beforeEach(async () => {
      await resetPostgresFixtures(pool);
      otpSender.sent.length = 0;
      phoneSequence = 1;
      categoryId = createId();
      papaId = createId();
      tomateId = createId();
      await pool.query(
        `INSERT INTO catalog.categories (id, name, parent_id, depth, created_at, updated_at) VALUES ($1, 'Hortalizas', NULL, 1, now(), now())`,
        [categoryId],
      );
      for (const [id, name] of [
        [papaId, 'Papa criolla'],
        [tomateId, 'Tomate chonto'],
      ] as const)
        await pool.query(
          `INSERT INTO catalog.products (id, category_id, name, search_text, unit, attributes, created_at, updated_at)
         VALUES ($1, $2, $3, lower($3), 'bulto', '{}', now(), now())`,
          [id, categoryId, name],
        );
    });

    const mapPapa = async (operator: Account) =>
      http()
        .post('/pricing/mappings')
        .set(bearer(operator))
        .send({
          id: createId(),
          productId: papaId,
          sourceProduct: 'Papa criolla limpia',
          presentation: 'Bulto 50 kg',
        })
        .expect(201);

    it('imports a reference file once, even twice at the same time, and rejects a bad file whole', async () => {
      const file = csv(
        '2026-11-20,Bogotá Corabastos,Papa criolla limpia,bulto 50 kg,80000',
        '2026-11-21,Bogotá Corabastos,Papa criolla limpia,bulto 50 kg,90000',
        '2026-11-22,Tunja Complejo,Papa criolla limpia,bulto 50 kg,100000',
      );
      const results = await Promise.all([
        service.importReferencePrices(file),
        service.importReferencePrices(file),
      ]);
      expect(results.map(({ status }) => status).sort()).toEqual(['already_imported', 'imported']);
      expect(await service.importReferencePrices(file)).toEqual({
        status: 'already_imported',
        rows: 3,
      });
      // Another file repeating an observation adds only what is new.
      expect(
        await service.importReferencePrices(
          csv(
            '2026-11-22,Tunja Complejo,Papa criolla limpia,bulto 50 kg,100000',
            '2026-11-23,Tunja Complejo,Papa criolla limpia,bulto 50 kg,95000',
          ),
        ),
      ).toEqual({ status: 'imported', rows: 1 });
      expect(
        (await pool.query(`SELECT count(*)::int AS n FROM recommendations.reference_prices`))
          .rows[0].n,
      ).toBe(4);

      const bad = await service.importReferencePrices(
        csv('2026-11-24,M,Papa,bulto,95000', '2026-11-24,M,Papa,bulto,abc'),
      );
      expect(bad).toEqual({
        status: 'invalid',
        errors: ['línea 3: precio inválido (entero en COP)'],
      });
      expect(
        (await pool.query(`SELECT count(*)::int AS n FROM recommendations.reference_prices`))
          .rows[0].n,
      ).toBe(4);
    });

    it('suggests a P25–P75 range with source and date, only to providers, never single prices', async () => {
      const supplier = await register('supplier');
      const buyer = await register('buyer');
      const operator = await createStaffAccount(app, pool, 'operator', `+57${nextPhone()}`);
      const suggest = (account: Account, productId = papaId, unit = 'bulto') =>
        http().get(`/pricing/suggestion?productId=${productId}&unit=${unit}`).set(bearer(account));

      expect((await suggest(supplier).expect(200)).body).toEqual({
        status: 'insufficient_data',
        productId: papaId,
        unit: 'bulto',
      });
      await suggest(buyer).expect(403);
      await suggest(supplier, createId()).expect(404);
      await http()
        .post('/pricing/mappings')
        .set(bearer(supplier))
        .send({ id: createId(), productId: papaId, sourceProduct: 'x', presentation: 'y' })
        .expect(403);

      const mapping = await mapPapa(operator);
      expect(mapping.body).toMatchObject({
        unit: 'bulto',
        sourceProduct: 'papa criolla limpia',
        presentation: 'bulto 50 kg',
      });
      const audit = await pool.query(
        `SELECT action FROM backoffice.audit_log WHERE entity = 'product_source_mapping'`,
      );
      expect(audit.rows).toEqual([{ action: 'pricing.mapping.create' }]);
      await service.importReferencePrices(
        csv(
          '2026-11-20,Bogotá Corabastos,Papa criolla limpia,bulto 50 kg,80000',
          '2026-11-21,Bogotá Corabastos,Papa criolla limpia,Bulto 50 KG,90000',
          // Older than RECOMMENDATIONS_REFERENCE_MAX_AGE_DAYS (30): ignored.
          '2026-09-01,Bogotá Corabastos,Papa criolla limpia,bulto 50 kg,10000',
        ),
      );
      // Two values: still below k = 3.
      expect((await suggest(supplier).expect(200)).body.status).toBe('insufficient_data');
      await service.importReferencePrices(
        csv('2026-11-22,Tunja Complejo,Papa criolla limpia,bulto 50 kg,100000'),
      );

      const ok = await suggest(supplier).expect(200);
      expect(ok.body).toEqual({
        status: 'ok',
        productId: papaId,
        unit: 'bulto',
        low: '85000',
        median: '90000',
        high: '95000',
        sources: [{ name: 'DANE-SIPSA', count: 3, observedAt: '2026-11-22T00:00:00.000Z' }],
        citation: 'Fuente: Departamento Administrativo Nacional de Estadística: www.dane.gov.co',
      });
      // Another unit has no data: no equivalence is assumed.
      expect((await suggest(supplier, papaId, 'kg').expect(200)).body.status).toBe(
        'insufficient_data',
      );
    });

    it('adds TRACOP prices only from three observations of two providers, storing no person ids', async () => {
      const operator = await createStaffAccount(app, pool, 'operator', `+57${nextPhone()}`);
      await mapPapa(operator);
      await service.importReferencePrices(
        csv(
          '2026-11-20,Bogotá,Papa criolla limpia,bulto 50 kg,80000',
          '2026-11-21,Bogotá,Papa criolla limpia,bulto 50 kg,90000',
          '2026-11-22,Bogotá,Papa criolla limpia,bulto 50 kg,100000',
        ),
      );
      const buyer = await register('buyer');
      const first = await register('supplier');
      const second = await register('supplier');
      const orders = [
        await acceptedOrder(buyer, await insertLot(first.userId, papaId, { price: 70_000 })),
        await acceptedOrder(buyer, await insertLot(first.userId, papaId, { price: 110_000 })),
      ];
      await deliver(['OrderAccepted']);
      await deliver(['OrderAccepted']); // at least once: counted once
      const check = await http()
        .get(`/pricing/suggestion?productId=${papaId}&unit=bulto`)
        .set(bearer(first))
        .expect(200);
      expect(check.body.sources.map(({ name }: { name: string }) => name)).toEqual(['DANE-SIPSA']);

      orders.push(
        await acceptedOrder(buyer, await insertLot(second.userId, papaId, { price: 75_000 })),
      );
      await deliver(['OrderAccepted']);
      const combined = await http()
        .get(`/pricing/suggestion?productId=${papaId}&unit=bulto`)
        .set(bearer(first))
        .expect(200);
      expect(combined.body).toMatchObject({
        low: '76250',
        median: '85000',
        high: '97500',
        sources: [
          { name: 'DANE-SIPSA', count: 3 },
          { name: 'TRACOP', count: 3 },
        ],
      });

      const stored = await pool.query(`SELECT * FROM recommendations.price_observations`);
      expect(stored.rows).toHaveLength(3);
      expect(
        findTextExposure(stored.rows, [buyer.userId, first.userId, second.userId, ...orders]),
      ).toEqual([]);
      expect(Object.keys(stored.rows[0] as object).sort()).toEqual(
        [
          'delivered_at',
          'id',
          'observed_at',
          'order_line_key',
          'product_id',
          'provider_key',
          'unit',
          'unit_price',
        ].sort(),
      );
    });

    it('recommends available lots deterministically, from the buyer’s own history only, without coordinates', async () => {
      const buyer = await register('buyer');
      const other = await register('buyer');
      const verifiedSupplier = await register('supplier');
      const supplier = await register('supplier');
      const operator = await createStaffAccount(app, pool, 'operator', `+57${nextPhone()}`);
      await http()
        .post('/trust/verification-requests')
        .set(bearer(verifiedSupplier))
        .send({})
        .expect(201);
      await http()
        .post(`/trust/staff/verifications/${verifiedSupplier.userId}/approve`)
        .set(bearer(operator))
        .send({
          checks: { contact_confirmed: true, location_confirmed: true, reference_checked: true },
        })
        .expect(200);

      const bought = await insertLot(supplier.userId, papaId);
      await acceptedOrder(buyer, bought);
      await deliver(['OrderAccepted']);
      const near = await insertLot(supplier.userId, tomateId, { at: { lat: 4.7, lng: -74.1 } });
      const verifiedLot = await insertLot(verifiedSupplier.userId, tomateId);
      const fresh = await insertLot(supplier.userId, papaId, { from: '2026-11-25T00:00:00Z' });
      await insertLot(supplier.userId, papaId, { status: 'draft' });
      await insertLot(supplier.userId, papaId, { status: 'cancelled' });
      await insertLot(supplier.userId, tomateId); // no reason at all

      const list = async (account: Account, query = '') =>
        (await http().get(`/recommendations/lots${query}`).set(bearer(account)).expect(200)).body;
      const page = await list(buyer, `?lat=${BOGOTA.lat}&lng=${BOGOTA.lng}&radiusKm=300`);
      const byLot = new Map(page.items.map((item: { lotId: string }) => [item.lotId, item]));
      expect(byLot.get(fresh)).toMatchObject({ reasons: ['reorder', 'fresh'], score: 40 });
      expect(byLot.get(near)).toMatchObject({
        reasons: ['nearby'],
        score: 20,
        distanceKm: expect.any(Number),
      });
      expect(Number.isInteger((byLot.get(near) as { distanceKm: number }).distanceKm)).toBe(true);
      expect(byLot.get(verifiedLot)).toMatchObject({ reasons: ['verified_provider'] });
      expect(page.items.map(({ score }: { score: number }) => score)).toEqual(
        [...page.items.map(({ score }: { score: number }) => score)].sort(
          (a: number, b: number) => b - a,
        ),
      );
      expect(page.items).toHaveLength(4); // the draft, the cancelled and the reasonless lot are out
      for (const item of page.items)
        expect(Object.keys(item).sort()).toEqual([
          'distanceKm',
          'lotId',
          'productId',
          'reasons',
          'score',
          'unit',
          'unitPrice',
        ]);
      expect(
        findCoordinateExposure(page, [
          { latitude: TUNJA.lat, longitude: TUNJA.lng },
          { latitude: 4.7, longitude: -74.1 },
        ]),
      ).toEqual([]);
      expect(findTextExposure(page, [supplier.userId, verifiedSupplier.userId])).toEqual([]);

      // Same request, same answer; one per page with the opaque cursor walks the same list.
      expect(await list(buyer, `?lat=${BOGOTA.lat}&lng=${BOGOTA.lng}&radiusKm=300`)).toEqual(page);
      const walked: string[] = [];
      let cursor: string | null = null;
      do {
        const next = await list(
          buyer,
          `?lat=${BOGOTA.lat}&lng=${BOGOTA.lng}&radiusKm=300&limit=1${cursor ? `&cursor=${cursor}` : ''}`,
        );
        walked.push(...next.items.map(({ lotId }: { lotId: string }) => lotId));
        cursor = next.nextCursor;
      } while (cursor);
      expect(walked).toEqual(page.items.map(({ lotId }: { lotId: string }) => lotId));
      await http().get('/recommendations/lots?cursor=forged').set(bearer(buyer)).expect(400);
      await http().get('/recommendations/lots?lat=4.6').set(bearer(buyer)).expect(400);

      // Another buyer's history is not used: no reorder for them.
      const theirs = await list(other);
      for (const item of theirs.items) expect(item.reasons).not.toContain('reorder');
      await http().get('/recommendations/lots').set(bearer(supplier)).expect(403);
    });

    it('notifies a matching alert once per lot, and keeps alerts private and bounded', async () => {
      const buyer = await register('buyer');
      const other = await register('buyer');
      const supplier = await register('supplier');
      const alert = {
        id: createId(),
        productId: papaId,
        maxPrice: 95_000,
        radiusKm: 200,
        lat: 4.65432,
        lng: -74.08361,
      };
      const created = await http().post('/alerts').set(bearer(buyer)).send(alert).expect(201);
      expect(created.body).toMatchObject({ centerLat: 4.65, centerLng: -74.08, maxPrice: '95000' });
      await http().post('/alerts').set(bearer(buyer)).send(alert).expect(200);
      expect(
        (
          await http()
            .post('/alerts')
            .set(bearer(buyer))
            .send({ ...alert, maxPrice: 1 })
            .expect(409)
        ).body.code,
      ).toBe('alert_conflict');
      await http()
        .post('/alerts')
        .set(bearer(supplier))
        .send({ ...alert, id: createId() })
        .expect(403);
      await http()
        .post('/alerts')
        .set(bearer(buyer))
        .send({ ...alert, id: createId(), productId: createId() })
        .expect(404);
      const stored = await pool.query(
        `SELECT center_lat::text, center_lng::text FROM recommendations.price_alerts`,
      );
      expect(stored.rows).toEqual([{ center_lat: '4.65', center_lng: '-74.08' }]);

      const matching = await insertLot(supplier.userId, papaId, { price: 90_000 });
      await insertLot(supplier.userId, papaId, { price: 99_000 }); // above the maximum
      await insertLot(supplier.userId, tomateId, { price: 1_000 }); // another product
      await insertLot(supplier.userId, papaId, { price: 80_000, at: { lat: 10.39, lng: -75.51 } }); // Cartagena, outside
      for (const lotId of (
        await pool.query<{ id: string }>(`SELECT id FROM catalog.lots`)
      ).rows.map(({ id }) => id))
        await pool.query(
          `INSERT INTO shared.outbox_events (id, aggregate, type, payload, created_at) VALUES ($1, $2, 'LotPublished', $3, now())`,
          [createId(), `lot:${lotId}`, JSON.stringify({ lotId })],
        );
      await deliver(['LotPublished']);
      await deliver(['LotPublished']); // at least once
      const matched = await pool.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM shared.outbox_events WHERE type = 'PriceAlertMatched'`,
      );
      expect(matched.rows.map(({ payload }) => payload)).toEqual([
        { buyerId: buyer.userId, alertId: alert.id, lotId: matching, amount: '90000' },
      ]);
      // notifications turns it into the buyer's lot_alert notice, once.
      const notifications = [app.get<OutboxSubscriberPort>(NOTIFICATIONS_OUTBOX_SUBSCRIBER)];
      await deliver(['PriceAlertMatched'], notifications);
      await deliver(['PriceAlertMatched'], notifications);
      const inbox = await pool.query(`SELECT user_id, kind, body FROM notifications.inbox`);
      expect(inbox.rows).toEqual([
        {
          user_id: buyer.userId,
          kind: 'lot_alert',
          body: 'Se publicó un lote del producto de tu alerta a $90.000 COP. Míralo en la app.',
        },
      ]);

      expect((await http().get('/alerts').set(bearer(other)).expect(200)).body.items).toEqual([]);
      await http().delete(`/alerts/${alert.id}`).set(bearer(other)).expect(404);
      await http().delete(`/alerts/${alert.id}`).set(bearer(buyer)).expect(204);
      expect((await http().get('/alerts').set(bearer(buyer)).expect(200)).body.items).toEqual([]);

      // RECOMMENDATIONS_ALERTS_PER_USER = 10.
      for (let index = 0; index < 10; index += 1)
        await http()
          .post('/alerts')
          .set(bearer(other))
          .send({ ...alert, id: createId() })
          .expect(201);
      expect(
        (
          await http()
            .post('/alerts')
            .set(bearer(other))
            .send({ ...alert, id: createId() })
            .expect(409)
        ).body.code,
      ).toBe('alert_limit');
    });

    it('lists and deletes mappings (audited), marks delivered observations and rate limits', async () => {
      const operator = await createStaffAccount(app, pool, 'operator', `+57${nextPhone()}`);
      const supplier = await register('supplier');
      const buyer = await register('buyer');
      const mapping = await mapPapa(operator);
      await http()
        .post('/pricing/mappings')
        .set(bearer(operator))
        .send({
          id: createId(),
          productId: papaId,
          sourceProduct: 'PAPA criolla  limpia',
          presentation: 'bulto 50 kg',
        })
        .expect(409);
      expect(
        (
          await http()
            .get(`/pricing/mappings?productId=${papaId}`)
            .set(bearer(operator))
            .expect(200)
        ).body.items,
      ).toHaveLength(1);
      await http().get('/pricing/mappings').set(bearer(buyer)).expect(403);
      await http().delete(`/pricing/mappings/${mapping.body.id}`).set(bearer(operator)).expect(204);
      await http().delete(`/pricing/mappings/${mapping.body.id}`).set(bearer(operator)).expect(404);
      const audit = await pool.query(
        `SELECT action FROM backoffice.audit_log WHERE entity = 'product_source_mapping' ORDER BY at, id`,
      );
      expect(audit.rows.map(({ action }) => action)).toEqual([
        'pricing.mapping.create',
        'pricing.mapping.delete',
      ]);

      const orderId = await acceptedOrder(buyer, await insertLot(supplier.userId, papaId));
      await deliver(['OrderAccepted']);
      await pool.query(
        `INSERT INTO shared.outbox_events (id, aggregate, type, payload, created_at) VALUES ($1, $2, 'OrderDelivered', '{}', now())`,
        [createId(), `order:${orderId}`],
      );
      await deliver(['OrderDelivered']);
      const delivered = await pool.query(
        `SELECT delivered_at FROM recommendations.price_observations`,
      );
      expect(delivered.rows).toEqual([{ delivered_at: NOW }]);

      // RECOMMENDATIONS_RATE_LIMIT = 60 per minute per user.
      const statuses: number[] = [];
      for (let index = 0; index < 61; index += 1)
        statuses.push(
          (
            await http()
              .get(`/pricing/suggestion?productId=${papaId}&unit=bulto`)
              .set(bearer(supplier))
          ).status,
        );
      expect(statuses.slice(0, 60).every((status) => status === 200)).toBe(true);
      expect(statuses[60]).toBe(429);
    });

    it('keeps alert centres, prices and histories out of the logs', async () => {
      const buyer = await register('buyer');
      logOutput = '';
      await http()
        .post('/alerts')
        .set(bearer(buyer))
        .send({
          id: createId(),
          productId: papaId,
          maxPrice: 87_654,
          radiusKm: 30,
          lat: 4.65432,
          lng: -74.08361,
        })
        .expect(201);
      await http()
        .get(`/recommendations/lots?lat=4.65432&lng=-74.08361`)
        .set(bearer(buyer))
        .expect(200);
      for (const secret of ['87654', '4.65432', '-74.08361', '4.65', buyer.userId])
        expect(logOutput.includes(secret)).toBe(false);
    });
  },
);
