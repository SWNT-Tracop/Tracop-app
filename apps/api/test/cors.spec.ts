import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { configureHttp } from '../src/bootstrap/http.js';

@Module({})
class EmptyCorsModule {}

const headerList = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .sort();

const createCorsApp = async (allowedOrigins: readonly string[]) => {
  const app = await NestFactory.create<NestExpressApplication>(EmptyCorsModule, {
    bodyParser: false,
    logger: false,
  });
  configureHttp(app, 256 * 1024, allowedOrigins);
  const express = app.getHttpAdapter().getInstance();
  express.get(
    '/catalog/products',
    (_request: unknown, response: { json: (body: unknown) => void }) => response.json([]),
  );
  express.post(
    '/webhooks/telegram',
    (_request: unknown, response: { sendStatus: (status: number) => void }) =>
      response.sendStatus(200),
  );
  await app.init();
  return app;
};

const corsHeaderNames = (headers: Record<string, unknown>) =>
  Object.keys(headers).filter((name) => name.startsWith('access-control-'));

describe('API CORS policy', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createCorsApp(['https://app.example.test']);
  });

  afterAll(async () => app.close());

  it('adds the configured headers for an allowed origin', async () => {
    const response = await request(app.getHttpServer())
      .options('/catalog/products')
      .set('Origin', 'https://app.example.test')
      .set('Access-Control-Request-Method', 'POST');
    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('https://app.example.test');
    expect(headerList(response.headers['access-control-allow-methods'])).toEqual([
      'DELETE',
      'GET',
      'OPTIONS',
      'PATCH',
      'POST',
      'PUT',
    ]);
    expect(headerList(response.headers['access-control-allow-headers'])).toEqual([
      'Accept',
      'Authorization',
      'Content-Type',
    ]);
    expect(response.headers.vary).toBe('Origin');
    expect(response.headers['access-control-expose-headers']).toBe('Retry-After');
    expect(response.headers['access-control-max-age']).toBe('600');
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('does not return ACAO for a disallowed origin', async () => {
    const response = await request(app.getHttpServer())
      .get('/catalog/products')
      .set('Origin', 'https://evil.example.test');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('does not apply CORS to the Telegram webhook', async () => {
    const response = await request(app.getHttpServer())
      .post('/webhooks/telegram')
      .set('Origin', 'https://app.example.test');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('does not answer a preflight from a disallowed origin', async () => {
    const response = await request(app.getHttpServer())
      .options('/catalog/products')
      .set('Origin', 'https://evil.example.test')
      .set('Access-Control-Request-Method', 'DELETE');
    expect(corsHeaderNames(response.headers)).toEqual([]);
  });

  it('emits no CORS headers at all when the allowlist is empty', async () => {
    const closed = await createCorsApp([]);
    try {
      for (const origin of ['https://app.example.test', 'http://localhost:5173']) {
        const preflight = await request(closed.getHttpServer())
          .options('/catalog/products')
          .set('Origin', origin)
          .set('Access-Control-Request-Method', 'GET');
        const simple = await request(closed.getHttpServer())
          .get('/catalog/products')
          .set('Origin', origin);
        expect(corsHeaderNames(preflight.headers)).toEqual([]);
        expect(corsHeaderNames(simple.headers)).toEqual([]);
      }
    } finally {
      await closed.close();
    }
  });
});
