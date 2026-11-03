import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/bootstrap/app.module.js';
import { describePostgres, resetPostgresFixtures } from './postgres-suite.js';
import { DATABASE_POOL } from '../src/shared/infra/tokens.js';
import pg from 'pg';

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
  it('returns the service health', async () => {
    await request(app.getHttpServer()).get('/health').expect(200).expect({ status: 'ok' });
  });
});
