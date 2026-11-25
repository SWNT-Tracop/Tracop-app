import { Test } from '@nestjs/testing';
import type { INestApplicationContext } from '@nestjs/common';
import pg from 'pg';
import { AppModule } from '../src/bootstrap/app.module.js';
import { TripPlanningService } from '../src/modules/logistics/index.js';
import { APP_CLOCK, DATABASE_POOL } from '../src/shared/infra/tokens.js';
import { createId } from '../src/shared/kernel/ids.js';
import { describePostgres, resetPostgresFixtures } from './postgres-suite.js';

describePostgres('logistics trip concurrency (PostgreSQL)', () => {
  const now = new Date('2026-11-20T12:00:00.000Z');
  let app: INestApplicationContext;
  let pool: pg.Pool;
  let trips: TripPlanningService;

  beforeAll(async () => {
    app = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_CLOCK)
      .useValue({ now: () => new Date(now) })
      .compile();
    await app.init();
    pool = app.get(DATABASE_POOL) as pg.Pool;
    trips = app.get(TripPlanningService);
  });

  beforeEach(async () => resetPostgresFixtures(pool));
  afterAll(async () => app.close());

  it('applies exactly one of two concurrent mutations with the same expected version', async () => {
    const carrier = { sub: createId(), role: 'carrier' };
    for (let iteration = 0; iteration < 20; iteration += 1) {
      const tripId = createId();
      await pool.query(
        `INSERT INTO logistics.trips (id, carrier_id, status, version, planned_at, created_at, updated_at)
         VALUES ($1, $2, 'assigned', 2, $3, $3, $3)`,
        [tripId, carrier.sub, now],
      );
      const results = await Promise.allSettled([
        trips.start(carrier, tripId, 2),
        trips.cancel(carrier, tripId, 2, 'Motivo sintético'),
      ]);
      const stored = await pool.query<{ status: string; version: number }>(
        `SELECT status, version FROM logistics.trips WHERE id = $1`,
        [tripId],
      );
      expect({
        iteration,
        fulfilled: results.filter((result) => result.status === 'fulfilled').length,
        version: stored.rows[0]?.version,
      }).toEqual({ iteration, fulfilled: 1, version: 3 });
    }
  });
});
