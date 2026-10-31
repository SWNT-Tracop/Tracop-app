import { Test } from '@nestjs/testing';
import { Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/bootstrap/app.module.js';
import { describePostgres } from './postgres-suite.js';
import { APP_LOGGER } from '../src/shared/infra/tokens.js';
import { OTP_SENDER } from '../src/modules/identity/ports/tokens.js';
import { InMemoryOtpSender } from '../src/modules/identity/adapters/out/otp-senders.js';
import { createLogger } from '../src/shared/infra/logger.js';
import { NestPinoLogger } from '../src/shared/infra/nest-pino-logger.js';

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describePostgres('identity logging redaction across the full flow', () => {
  let app: INestApplication;
  let otpSender: InMemoryOtpSender;
  let loggerOutput = '';
  let processOutput = '';
  let stdoutSpy: jest.SpyInstance | undefined;
  let stderrSpy: jest.SpyInstance | undefined;

  beforeAll(async () => {
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        loggerOutput += chunk.toString();
        callback();
      },
    });
    const logger = createLogger('development', destination);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_LOGGER)
      .useValue(logger)
      .compile();
    app = moduleRef.createNestApplication();
    app.useLogger(new NestPinoLogger(app.get(APP_LOGGER)));
    await app.listen(0, '127.0.0.1');
    otpSender = app.get(OTP_SENDER) as InMemoryOtpSender;
  });

  afterAll(async () => {
    stdoutSpy?.mockRestore();
    stderrSpy?.mockRestore();
    await app.close();
  });

  it('never emits full phone, OTP, tokens, Authorization header or plain IP', async () => {
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      processOutput += String(chunk);
      return true;
    }) as never);
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      processOutput += String(chunk);
      return true;
    }) as never);

    const phone = `301${String(7_000_000 + Math.floor(Math.random() * 1_000_000)).slice(0, 7)}`;
    const deviceId = randomUUID();
    const server = app.getHttpServer();

    await request(server)
      .post('/auth/register')
      .set('X-Forwarded-For', '203.0.113.9')
      .send({
        phone,
        role: 'buyer',
        fullName: 'Persona de prueba',
        deviceId,
        platform: 'web',
        consent: { accepted: true, version: 'v0-draft' },
      })
      .expect(201);
    const code = otpSender.sent.at(-1)!.code as string;

    const verified = await request(server)
      .post('/auth/otp/verify')
      .set('X-Forwarded-For', '203.0.113.9')
      .send({ phone, deviceId, platform: 'web', code })
      .expect(201);
    const accessToken = verified.body.accessToken as string;
    const refreshToken = verified.body.refreshToken as string;

    await request(server).get('/me').set('Authorization', `Bearer ${accessToken}`).expect(200);

    const rotated = await request(server)
      .post('/auth/refresh')
      .send({ refreshToken, deviceId })
      .expect(201);
    const rotatedRefresh = rotated.body.refreshToken as string;

    await request(server)
      .post('/auth/logout')
      .set('Authorization', `Bearer ${rotated.body.accessToken}`)
      .expect(201);

    await request(server)
      .post('/auth/otp/request')
      .set('X-Forwarded-For', '203.0.113.9')
      .send({ phone })
      .expect((response) => {
        expect([201, 429]).toContain(response.status);
      });

    const logger = app.get<ReturnType<typeof createLogger>>(APP_LOGGER);
    logger.info(
      {
        phone: `+57${phone}`,
        otp: code,
        accessToken,
        refreshToken,
        authorization: `Bearer ${accessToken}`,
        ip: '127.0.0.1',
        remoteAddress: '::ffff:127.0.0.1',
        req: {
          ip: '127.0.0.1',
          socket: { remoteAddress: '::ffff:127.0.0.1' },
          headers: {
            authorization: `Bearer ${accessToken}`,
            'x-forwarded-for': '203.0.113.9',
          },
        },
      },
      'redaction probe',
    );

    await flush();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    stdoutSpy = undefined;
    stderrSpy = undefined;
    const output = `${loggerOutput}${processOutput}`;
    const probeLine = output.split('\n').find((line) => line.includes('redaction probe')) as string;

    expect(probeLine).toContain('[REDACTED]');
    expect(output).not.toContain(`+57${phone}`);
    expect(output).not.toContain(`code=${code}`);
    expect(output).not.toContain(`"otp":"${code}"`);
    expect(output).not.toContain(accessToken);
    expect(output).not.toContain(refreshToken);
    expect(output).not.toContain(rotatedRefresh);
    expect(output).not.toContain('Bearer ');
    expect(output).not.toContain('127.0.0.1');
    expect(output).not.toContain('203.0.113.9');
  });
});
