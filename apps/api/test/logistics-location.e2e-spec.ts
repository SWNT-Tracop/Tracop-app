import { Writable } from 'node:stream';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import request from 'supertest';
import { AppModule } from '../src/bootstrap/app.module.js';
import { InMemoryOtpSender } from '../src/modules/identity/adapters/out/otp-senders.js';
import { OTP_SENDER } from '../src/modules/identity/ports/tokens.js';
import { LOGISTICS_CLOCK } from '../src/modules/logistics/index.js';
import { createLogger } from '../src/shared/infra/logger.js';
import { NestPinoLogger } from '../src/shared/infra/nest-pino-logger.js';
import { APP_LOGGER, DATABASE_POOL } from '../src/shared/infra/tokens.js';
import { createId } from '../src/shared/kernel/ids.js';
import { findCoordinateExposure } from './helpers/coordinate-exposure.js';
import { createStaffAccount } from './helpers/staff-account.js';
import { findTextExposure } from './helpers/text-exposure.js';
import { describePostgres, resetPostgresFixtures } from './postgres-suite.js';

type Account = { readonly token: string; readonly userId: string };

const LOT_A = { latitude: 5.5312, longitude: -73.3615 };
const LOT_B = { latitude: 5.6173, longitude: -73.4128 };
const ADDRESS = 'Carrera 7 # 72-41, Chapinero, Bogotá';

/** A clock the test moves by hand; the logistics module (and its rate limiter) read it. */
class ManualClock {
  private current = new Date('2026-11-25T15:00:00.000Z');
  now(): Date {
    return new Date(this.current);
  }
  advance(seconds: number): void {
    this.current = new Date(this.current.getTime() + seconds * 1000);
  }
}

describePostgres('exact locations for the assigned carrier and staff (Nest + PostgreSQL)', () => {
  let app: INestApplication;
  let pool: pg.Pool;
  let otpSender: InMemoryOtpSender;
  let clock: ManualClock;
  let logOutput = '';
  let phoneSequence = 1;
  let productId: string;

  const http = () => request(app.getHttpServer());
  const bearer = (account: Account) => ({ Authorization: `Bearer ${account.token}` });
  const nextPhone = () => `308${String(phoneSequence++).padStart(7, '0')}`;

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

  const insertLot = async (providerId: string, point: typeof LOT_A) => {
    const lotId = createId();
    await pool.query(
      `INSERT INTO catalog.lots (id, provider_id, product_id, quantity, unit, unit_price, quality_grade,
         available_from, available_until, location_lat, location_lng, status, version, created_at, updated_at)
       VALUES ($1, $2, $3, 10, 'kg', 4500, NULL, NOW() - INTERVAL '1 hour', NOW() + INTERVAL '7 days',
         $4, $5, 'published', 1, NOW(), NOW())`,
      [lotId, providerId, productId, point.latitude, point.longitude],
    );
    return lotId;
  };

  /**
   * A paid order of two lots at different places and a trip that takes it, assigned to its
   * carrier. Payment is simulated (as in logistics.e2e-spec) to focus on locations.
   */
  const assignedTrip = async () => {
    const supplier = await register('supplier');
    const buyer = await register('buyer');
    const carrier = await register('carrier');
    const lotA = await insertLot(supplier.userId, LOT_A);
    const lotB = await insertLot(supplier.userId, LOT_B);
    const orderId = createId();
    const created = await http()
      .post('/orders')
      .set(bearer(buyer))
      .send({
        id: orderId,
        lines: [
          { lotId: lotA, quantityMilli: '1000' },
          { lotId: lotB, quantityMilli: '1000' },
        ],
        deliveryAddress: ADDRESS,
      })
      .expect(201);
    await http()
      .post(`/orders/${orderId}/accept`)
      .set(bearer(buyer))
      .send({ expectedVersion: created.body.version })
      .expect(200);
    await pool.query(
      `UPDATE ordering.orders SET status = 'paid', version = version + 1 WHERE id = $1`,
      [orderId],
    );
    await http()
      .post('/logistics/carrier-profile')
      .set(bearer(carrier))
      .send({ vehicleType: 'Camion', capacityKg: 2000, plate: `LOC${phoneSequence}` })
      .expect(201);
    const trip = await http()
      .post('/logistics/trips')
      .set(bearer(carrier))
      .send({ id: createId(), orderIds: [orderId] })
      .expect(201);
    const stops = (
      await http().get(`/logistics/trips/${trip.body.id}/stops`).set(bearer(carrier)).expect(200)
    ).body as { id: string; kind: 'pickup' | 'delivery' }[];
    return {
      supplier,
      buyer,
      carrier,
      orderId,
      lotA,
      tripId: trip.body.id as string,
      tripVersion: trip.body.version as number,
      pickup: stops.find((stop) => stop.kind === 'pickup')!,
      delivery: stops.find((stop) => stop.kind === 'delivery')!,
    };
  };

  const stopLocation = (account: Account, tripId: string, stopId: string) =>
    http().get(`/logistics/trips/${tripId}/stops/${stopId}/location`).set(bearer(account));

  const audits = async (tripId: string) =>
    (
      await pool.query<{ actor_id: string; actor_role: string; after: Record<string, unknown> }>(
        `SELECT actor_id, actor_role, after FROM backoffice.audit_log
         WHERE action = 'location.view' AND entity_id = $1 ORDER BY at, id`,
        [tripId],
      )
    ).rows;

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
      .overrideProvider(LOGISTICS_CLOCK)
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
    // A fresh rate-limit window for every test.
    clock.advance(3600);
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

  it('gives the assigned carrier every distinct pickup point and the delivery address, uncached and audited', async () => {
    const trip = await assignedTrip();

    const pickup = await stopLocation(trip.carrier, trip.tripId, trip.pickup.id).expect(200);
    expect(pickup.headers['cache-control']).toBe('no-store');
    expect(pickup.body).toEqual({
      stopId: trip.pickup.id,
      kind: 'pickup',
      orderId: trip.orderId,
      points: [
        { lat: LOT_A.latitude, lng: LOT_A.longitude },
        { lat: LOT_B.latitude, lng: LOT_B.longitude },
      ],
    });
    const delivery = await stopLocation(trip.carrier, trip.tripId, trip.delivery.id).expect(200);
    expect(delivery.body).toEqual({
      stopId: trip.delivery.id,
      kind: 'delivery',
      orderId: trip.orderId,
      address: ADDRESS,
    });

    expect(await audits(trip.tripId)).toEqual([
      {
        actor_id: trip.carrier.userId,
        actor_role: 'carrier',
        after: { scope: 'stop', stopId: trip.pickup.id, result: 'granted' },
      },
      {
        actor_id: trip.carrier.userId,
        actor_role: 'carrier',
        after: { scope: 'stop', stopId: trip.delivery.id, result: 'granted' },
      },
    ]);
  });

  it('answers 404 to another carrier, the buyer and the provider, auditing each denial', async () => {
    const trip = await assignedTrip();
    const otherCarrier = await register('carrier');

    for (const account of [otherCarrier, trip.buyer, trip.supplier])
      await stopLocation(account, trip.tripId, trip.pickup.id).expect(404);
    await http()
      .get(`/logistics/trips/${trip.tripId}/location-pack`)
      .set(bearer(otherCarrier))
      .expect(404);
    // A stop of another trip, or no stop at all, is the same 404.
    await stopLocation(trip.carrier, trip.tripId, createId()).expect(404);

    expect((await audits(trip.tripId)).map(({ actor_id, after }) => [actor_id, after])).toEqual([
      [otherCarrier.userId, { scope: 'stop', stopId: trip.pickup.id, result: 'denied' }],
      [trip.buyer.userId, { scope: 'stop', stopId: trip.pickup.id, result: 'denied' }],
      [trip.supplier.userId, { scope: 'stop', stopId: trip.pickup.id, result: 'denied' }],
      [otherCarrier.userId, { scope: 'pack', result: 'denied' }],
      [trip.carrier.userId, { scope: 'stop', stopId: expect.any(String), result: 'denied' }],
    ]);
  });

  it('lets operators and admins see it, always audited', async () => {
    const trip = await assignedTrip();
    const operator = await createStaffAccount(app, pool, 'operator', `+57${nextPhone()}`);
    const admin = await createStaffAccount(app, pool, 'admin', `+57${nextPhone()}`);
    const finance = await createStaffAccount(app, pool, 'finance', `+57${nextPhone()}`);

    expect(
      (await stopLocation(operator, trip.tripId, trip.delivery.id).expect(200)).body.address,
    ).toBe(ADDRESS);
    await http()
      .get(`/logistics/trips/${trip.tripId}/location-pack`)
      .set(bearer(admin))
      .expect(200);
    await stopLocation(finance, trip.tripId, trip.delivery.id).expect(404);

    expect((await audits(trip.tripId)).map(({ actor_role, after }) => [actor_role, after])).toEqual(
      [
        ['operator', { scope: 'stop', stopId: trip.delivery.id, result: 'granted' }],
        ['admin', { scope: 'pack', result: 'granted' }],
        ['finance', { scope: 'stop', stopId: trip.delivery.id, result: 'denied' }],
      ],
    );
  });

  it('stops serving a completed pickup, then the delivery once done, and nothing for a planned or cancelled trip', async () => {
    const trip = await assignedTrip();
    const checkin = (stopId: string, kind: 'pickup' | 'delivery') =>
      http()
        .post(`/logistics/stops/${stopId}/checkins`)
        .set(bearer(trip.carrier))
        .send({ id: createId(), kind, clientAt: clock.now().toISOString() })
        .expect(201);

    await checkin(trip.pickup.id, 'pickup');
    await stopLocation(trip.carrier, trip.tripId, trip.pickup.id).expect(404);
    await stopLocation(trip.carrier, trip.tripId, trip.delivery.id).expect(200);
    const pack = await http()
      .get(`/logistics/trips/${trip.tripId}/location-pack`)
      .set(bearer(trip.carrier))
      .expect(200);
    expect(pack.body.stops.map(({ kind }: { kind: string }) => kind)).toEqual(['delivery']);

    await checkin(trip.delivery.id, 'delivery');
    await stopLocation(trip.carrier, trip.tripId, trip.delivery.id).expect(404);
    await http()
      .get(`/logistics/trips/${trip.tripId}/location-pack`)
      .set(bearer(trip.carrier))
      .expect(404);

    const cancelled = await assignedTrip();
    await http()
      .post(`/logistics/trips/${cancelled.tripId}/cancel`)
      .set(bearer(cancelled.carrier))
      .send({ expectedVersion: cancelled.tripVersion, reason: 'Lluvia' })
      .expect(200);
    await stopLocation(cancelled.carrier, cancelled.tripId, cancelled.pickup.id).expect(404);

    const planned = await assignedTrip();
    await pool.query(`UPDATE logistics.trips SET status = 'planned' WHERE id = $1`, [
      planned.tripId,
    ]);
    await stopLocation(planned.carrier, planned.tripId, planned.pickup.id).expect(404);
  });

  it('serves the pending stops as a pack that expires after the PROVISIONAL TTL', async () => {
    const trip = await assignedTrip();

    const pack = await http()
      .get(`/logistics/trips/${trip.tripId}/location-pack`)
      .set(bearer(trip.carrier))
      .expect(200);

    expect(pack.headers['cache-control']).toBe('no-store');
    // Trips have no planned end yet, so the cap applies: LOGISTICS_LOCATION_MAX_TTL_HOURS = 24.
    expect(pack.body.expiresAt).toBe(
      new Date(clock.now().getTime() + 24 * 3_600_000).toISOString(),
    );
    expect(pack.body.stops.map(({ kind }: { kind: string }) => kind).sort()).toEqual([
      'delivery',
      'pickup',
    ]);
  });

  it('limits how often one user may ask', async () => {
    const trip = await assignedTrip();
    for (let request = 0; request < 30; request += 1)
      await stopLocation(trip.carrier, trip.tripId, trip.pickup.id).expect(200);
    const limited = await stopLocation(trip.carrier, trip.tripId, trip.pickup.id).expect(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    clock.advance(61);
    await stopLocation(trip.carrier, trip.tripId, trip.pickup.id).expect(200);
  });

  it('refuses to move a lot with reserved stock (409 lot_location_locked)', async () => {
    const trip = await assignedTrip();
    const lot = await pool.query<{ version: number }>(
      `SELECT version FROM catalog.lots WHERE id = $1`,
      [trip.lotA],
    );

    const moved = await http()
      .patch(`/lots/${trip.lotA}`)
      .set(bearer(trip.supplier))
      .send({ version: lot.rows[0]!.version, locationLat: 5.7, locationLng: -73.5 })
      .expect(409);

    expect(moved.body.code).toBe('lot_location_locked');
    const after = await pool.query<{ location_lat: number }>(
      `SELECT location_lat FROM catalog.lots WHERE id = $1`,
      [trip.lotA],
    );
    expect(after.rows[0]!.location_lat).toBe(LOT_A.latitude);
  });

  it('keeps coordinates and addresses out of every other logistics response, sync and the logs', async () => {
    logOutput = '';
    const trip = await assignedTrip();
    const coordinates = [LOT_A, LOT_B];
    const responses = [
      await http().get('/logistics/trips/mine').set(bearer(trip.carrier)).expect(200),
      await http().get(`/logistics/trips/${trip.tripId}`).set(bearer(trip.carrier)).expect(200),
      await http()
        .get(`/logistics/trips/${trip.tripId}/stops`)
        .set(bearer(trip.carrier))
        .expect(200),
      await http().get('/sync/pull').set(bearer(trip.carrier)).expect(200),
    ];
    // Asking for the exact location (granted or denied) must not leak it into any log or the
    // process output either.
    let processOutput = '';
    const capture = (chunk: unknown) => {
      processOutput += String(chunk);
      return true;
    };
    const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(capture as never);
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(capture as never);
    try {
      await stopLocation(trip.carrier, trip.tripId, trip.pickup.id).expect(200);
      await stopLocation(trip.carrier, trip.tripId, trip.delivery.id).expect(200);
      await stopLocation(trip.buyer, trip.tripId, trip.delivery.id).expect(404);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }

    for (const { body } of responses) {
      expect(findCoordinateExposure(body, coordinates)).toEqual([]);
      expect(findTextExposure(body, [ADDRESS, 'Carrera 7'])).toEqual([]);
    }
    const changes = await pool.query<{ payload: unknown }>(`SELECT payload FROM sync.change_log`);
    for (const { payload } of changes.rows) {
      expect(findCoordinateExposure(payload, coordinates, ['locationLat', 'locationLng'])).toEqual(
        [],
      );
      expect(findTextExposure(payload, [ADDRESS])).toEqual([]);
    }
    // The API logs no per-request line here; whatever was written is parsed and inspected.
    const lines = `${logOutput}\n${processOutput}`.split('\n').filter((line) => line.trim());
    const entries = lines.map((line) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        return line;
      }
    });
    for (const entry of entries) {
      expect(findCoordinateExposure(entry, coordinates)).toEqual([]);
      expect(findTextExposure(entry, [ADDRESS])).toEqual([]);
    }
    const auditRows = await pool.query<{ after: unknown }>(
      `SELECT after FROM backoffice.audit_log`,
    );
    for (const { after } of auditRows.rows) {
      expect(findCoordinateExposure(after, coordinates)).toEqual([]);
      expect(findTextExposure(after, [ADDRESS])).toEqual([]);
    }
  });
});
