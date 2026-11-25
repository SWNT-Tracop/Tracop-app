import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { configureHttp } from '../src/bootstrap/http.js';

@Module({})
class EmptyModule {}

describe('route-specific sync push body limit', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await NestFactory.create<NestExpressApplication>(EmptyModule, { bodyParser: false });
    configureHttp(app, 256 * 1024);
    const express = app.getHttpAdapter().getInstance();
    express.post(
      '/sync/push',
      (req: { body: { payload: string } }, res: { json: (value: unknown) => void }) => {
        res.json({ length: req.body.payload.length });
      },
    );
    express.post('/other', (_req: unknown, res: { sendStatus: (status: number) => void }) => {
      res.sendStatus(200);
    });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('accepts a push body over the global 64 KiB cap up to 256 KiB, rejecting larger bodies', async () => {
    const withinPushLimit = await request(app.getHttpServer())
      .post('/sync/push')
      .send({ payload: 'x'.repeat(200 * 1024) });
    expect(withinPushLimit.status).toBe(200);

    const overPushLimit = await request(app.getHttpServer())
      .post('/sync/push')
      .send({ payload: 'x'.repeat(260 * 1024) });
    expect(overPushLimit.status).toBe(413);
  });

  it('keeps the global 64 KiB limit for other routes', async () => {
    const response = await request(app.getHttpServer())
      .post('/other')
      .send({ payload: 'x'.repeat(70 * 1024) });
    expect(response.status).toBe(413);
  });
});
