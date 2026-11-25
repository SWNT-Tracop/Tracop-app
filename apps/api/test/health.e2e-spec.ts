import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/bootstrap/app.module.js';
import { describePostgres, resetPostgresFixtures } from './postgres-suite.js';
import { DATABASE_POOL } from '../src/shared/infra/tokens.js';
import pg from 'pg';
import { LOT_QUOTE_PORT } from '../src/modules/ordering/ports/ordering-ports.js';
import { CATALOG_ORDERING_API } from '../src/modules/catalog/index.js';
import { CatalogLotReservationAdapter } from '../src/bootstrap/ordering-bridge.module.js';

describePostgres('GET /health', () => {
  let app: INestApplication;
  let pool: pg.Pool;
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
    pool = app.get(DATABASE_POOL) as pg.Pool;
    await resetPostgresFixtures(pool);
  });
  afterAll(async () => app.close());
  it('starts the real AppModule and returns the service health', async () => {
    await request(app.getHttpServer()).get('/health').expect(200).expect({ status: 'ok' });
  });

  it('fails the real bridge smoke if the catalog ordering dependency is broken', () => {
    const quotePort = app.get(LOT_QUOTE_PORT);
    expect(quotePort).toBeDefined();
    expect(app.get(CATALOG_ORDERING_API)).toBeDefined();
  });

  it('propagates unknown reservation bridge failures without converting them', async () => {
    const bridgeFailure = new Error('bridge_dependency_failure');
    const adapter = new CatalogLotReservationAdapter({
      getLotQuote: async () => {
        throw bridgeFailure;
      },
      reserveLots: async () => {
        throw bridgeFailure;
      },
      releaseOrderReservations: async () => {
        throw bridgeFailure;
      },
      findExpiredReservationOrderIds: async () => [],
      getLotLocations: async () => new Map(),
      holdOrderReservations: async () => undefined,
      resumeOrderReservationExpiry: async () => undefined,
      consumeOrderReservations: async () => undefined,
      isOrderReservationExpired: async () => false,
    });
    await expect(
      adapter.reserve('018f47a2-8b45-7cc2-9a1e-123456789abc', [], new Date()),
    ).rejects.toBe(bridgeFailure);
  });
});
