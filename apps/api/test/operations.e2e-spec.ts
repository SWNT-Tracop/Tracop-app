import { Writable } from 'node:stream';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import request from 'supertest';
import { AppModule } from '../src/bootstrap/app.module.js';
import { configureHttp } from '../src/bootstrap/http.js';
import { createLogger } from '../src/shared/infra/logger.js';
import { APP_CLOCK, APP_LOGGER, DATABASE_POOL } from '../src/shared/infra/tokens.js';
import { createId } from '../src/shared/kernel/ids.js';
import { HTTP_METRICS } from '../src/shared/ports/operations.js';
import { describePostgres, resetPostgresFixtures } from './postgres-suite.js';

const TOKEN = 'metrics-token-for-tests-0123456789abcdef';
const NOW = new Date('2026-11-25T15:00:00.000Z');

describePostgres('operations: readiness, metrics and request logs (Nest + PostgreSQL)', () => {
  let app: INestApplication;
  let pool: pg.Pool;
  let logOutput = '';
  let previousToken: string | undefined;

  const beat = (at: Date) =>
    pool.query(
      `INSERT INTO shared.worker_heartbeats (worker_id, beat_at) VALUES ('host:1', $1)
       ON CONFLICT (worker_id) DO UPDATE SET beat_at = EXCLUDED.beat_at`,
      [at],
    );

  beforeAll(async () => {
    previousToken = process.env.METRICS_TOKEN;
    process.env.METRICS_TOKEN = TOKEN;
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        logOutput += chunk.toString();
        callback();
      },
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_CLOCK)
      .useValue({ now: () => new Date(NOW) })
      .overrideProvider(APP_LOGGER)
      .useValue(createLogger('development', destination))
      .compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    configureHttp(app, 256 * 1024, [], {
      logger: app.get(APP_LOGGER),
      metrics: app.get(HTTP_METRICS),
    });
    await app.listen(0, '127.0.0.1');
    pool = app.get(DATABASE_POOL) as pg.Pool;
  });

  afterAll(async () => {
    await app?.close();
    if (previousToken === undefined) delete process.env.METRICS_TOKEN;
    else process.env.METRICS_TOKEN = previousToken;
  });

  beforeEach(async () => {
    await resetPostgresFixtures(pool);
    await pool.query('TRUNCATE shared.worker_heartbeats');
  });

  it('is ready only with the database up and a recent worker heartbeat', async () => {
    const http = () => request(app.getHttpServer());
    expect((await http().get('/ready').expect(503)).body).toEqual({
      status: 'not_ready',
      database: 'ok',
      worker: 'stale',
    });
    await beat(new Date(NOW.getTime() - 60_000));
    expect((await http().get('/ready').expect(200)).body).toEqual({
      status: 'ready',
      database: 'ok',
      worker: 'ok',
    });
    await beat(new Date(NOW.getTime() - 181_000)); // READY_WORKER_MAX_AGE_SECONDS = 180
    expect((await http().get('/ready').expect(503)).body.worker).toBe('stale');
    await http().get('/health').expect(200);
  });

  it('serves Prometheus metrics only with the token, labelled by route template', async () => {
    const http = () => request(app.getHttpServer());
    const lotId = createId();
    await http().get(`/lots/${lotId}?secret=1`).expect(401);
    await beat(new Date(NOW.getTime() - 30_000));
    await http().get('/metrics').expect(404);
    await http()
      .get('/metrics')
      .set('Authorization', 'Bearer wrong-token-wrong-token-wrong-token')
      .expect(404);
    const response = await http()
      .get('/metrics')
      .set('Authorization', `Bearer ${TOKEN}`)
      .expect(200);
    expect(response.headers['content-type']).toContain('text/plain');
    const lines = response.text.split('\n');
    expect(lines).toContain(
      'tracop_http_requests_total{method="GET",route="/lots/:id",status="401"} 1',
    );
    expect(lines).toContain('tracop_worker_heartbeat_age_seconds 30');
    expect(lines.some((line) => line.startsWith('tracop_outbox_pending '))).toBe(true);
    expect(response.text.includes(lotId)).toBe(false);
    expect(response.text.includes('secret')).toBe(false);
  });

  it('logs one structured line per request with a request id, never the concrete path or query', async () => {
    logOutput = '';
    const lotId = createId();
    const response = await request(app.getHttpServer())
      .get(`/lots/${lotId}?phone=3001234567`)
      .expect(401);
    const requestId = response.headers['x-request-id'];
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    const entries = logOutput
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.event === 'http_request');
    expect(entries).toEqual([
      expect.objectContaining({
        requestId,
        method: 'GET',
        route: '/lots/:id',
        status: 401,
        durationMs: expect.any(Number),
      }),
    ]);
    expect(logOutput.includes(lotId)).toBe(false);
    expect(logOutput.includes('3001234567')).toBe(false);
  });
});
