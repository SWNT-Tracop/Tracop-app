import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/bootstrap/app.module.js';
import { setupSwagger, createOpenApiDocument } from '../src/shared/infra/swagger.js';
import { DATABASE_POOL } from '../src/shared/infra/tokens.js';
import { describePostgres, resetPostgresFixtures } from './postgres-suite.js';
import pg from 'pg';

describePostgres('OpenAPI metadata and production docs exposure', () => {
  let app: INestApplication;
  let pool: pg.Pool;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    setupSwagger(app, 'production');
    await app.listen(0, '127.0.0.1');
    pool = app.get(DATABASE_POOL) as pg.Pool;
    await resetPostgresFixtures(pool);
  });

  afterAll(async () => app.close());

  it('documents every exposed operation with a summary, tags, and at least one error response', () => {
    const document = createOpenApiDocument(app);
    const operations = Object.values(document.paths ?? {}).flatMap((path) =>
      Object.values(path ?? {}).filter(
        (operation): operation is NonNullable<typeof operation> =>
          typeof operation === 'object' && operation !== null && 'responses' in operation,
      ),
    );
    expect(operations.length).toBeGreaterThan(0);
    for (const operation of operations) {
      expect(operation.summary).toEqual(expect.any(String));
      expect(operation.tags?.length).toBeGreaterThan(0);
      expect(Object.keys(operation.responses ?? {}).some((status) => Number(status) >= 400)).toBe(
        true,
      );
    }
    expect(document.paths).not.toHaveProperty('/webhooks/telegram');
  });

  it.each(['/docs', '/docs-json'])('%s returns 404 in production', async (path) => {
    await request(app.getHttpServer()).get(path).expect(404);
  });
});
