import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/bootstrap/app.module.js';
import { configureHttp } from '../src/bootstrap/http.js';
import { TelegramOtpSender } from '../src/bootstrap/telegram-otp-sender.adapter.js';
import {
  IDENTITY_CHANNEL_APPLICATION,
  OTP_SENDER,
  type IdentityChannelApplication,
} from '../src/modules/identity/index.js';
import {
  MESSAGING_PORT,
  messagingMessages,
  type MessagingPort,
} from '../src/modules/messaging/index.js';
import {
  APP_ENVIRONMENT,
  APP_LOGGER,
  BACKGROUND_DISPATCHER,
  DATABASE_POOL,
} from '../src/shared/infra/tokens.js';
import type { BackgroundDispatcher } from '../src/shared/ports/background-dispatcher.js';
import { loadAppEnvironment } from '../src/shared/infra/env.js';
import type { Pool } from 'pg';
import type pino from 'pino';
import { FakeMessagingAdapter } from './support/fake-messaging.js';

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const secret = (): string => process.env.TELEGRAM_WEBHOOK_SECRET ?? '';

const privateUpdate = (id: number, overrides: Record<string, unknown> = {}) => ({
  update_id: id,
  message: {
    message_id: id,
    date: 1_767_225_600,
    chat: { id: 900001, type: 'private' },
    from: { id: 900001, is_bot: false },
    ...overrides,
  },
});

describe('Telegram webhook flow', () => {
  let app: INestApplication;
  let messaging: FakeMessagingAdapter;
  let pool: Pool;
  const phone = '3011234567';
  const deviceId = randomUUID();

  beforeAll(async () => {
    messaging = new FakeMessagingAdapter();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_ENVIRONMENT)
      .useValue({
        ...loadAppEnvironment(),
        OTP_PHONE_COOLDOWN_LIMIT: 2,
        OTP_PHONE_LIMIT: 5,
      })
      .overrideProvider(MESSAGING_PORT)
      .useValue(messaging)
      .overrideProvider(OTP_SENDER)
      .useFactory({
        inject: [IDENTITY_CHANNEL_APPLICATION, MESSAGING_PORT, APP_LOGGER],
        factory: (identity: IdentityChannelApplication, port: MessagingPort, logger: pino.Logger) =>
          new TelegramOtpSender(identity, port, logger),
      })
      .compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    configureHttp(app);
    await app.init();
    pool = app.get(DATABASE_POOL) as Pool;
    expect(app.get(OTP_SENDER)).toBeInstanceOf(TelegramOtpSender);
  });

  afterAll(async () => {
    await app.close();
  });

  it('registers, links the channel, delivers the OTP, verifies and serves /me', async () => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        phone,
        role: 'buyer',
        fullName: 'Comprador de prueba',
        deviceId,
        platform: 'web',
        consent: { accepted: true, version: 'v0-draft' },
      })
      .expect(201);

    await request(app.getHttpServer())
      .post('/webhooks/telegram')
      .set('X-Telegram-Bot-Api-Secret-Token', secret())
      .send(privateUpdate(1001, { text: '/start' }))
      .expect(200);
    await flush();
    expect(messaging.sent.at(-1)?.text).toBe(messagingMessages.start);

    await request(app.getHttpServer())
      .post('/webhooks/telegram')
      .set('X-Telegram-Bot-Api-Secret-Token', secret())
      .send(
        privateUpdate(1002, {
          contact: { phone_number: `+57${phone}`, user_id: 900001 },
        }),
      )
      .expect(200);
    await flush();
    expect(messaging.sent.at(-1)?.text).toBe(messagingMessages.linked);

    const beforeDuplicate = messaging.sent.length;
    await request(app.getHttpServer())
      .post('/webhooks/telegram')
      .set('X-Telegram-Bot-Api-Secret-Token', secret())
      .send(
        privateUpdate(1002, {
          contact: { phone_number: `+57${phone}`, user_id: 900001 },
        }),
      )
      .expect(200);
    await flush();
    expect(messaging.sent).toHaveLength(beforeDuplicate);
    const processed = await pool.query<{ count: string }>(
      'SELECT count(*) FROM messaging.processed_updates WHERE update_id = $1',
      [1002],
    );
    expect(processed.rows[0]?.count).toBe('1');

    await request(app.getHttpServer()).post('/auth/otp/request').send({ phone }).expect(201);
    await (app.get(BACKGROUND_DISPATCHER) as BackgroundDispatcher).flush();
    await flush();
    const otpMessage = messaging.sent.at(-1)?.text ?? '';
    const code = otpMessage.match(/\d{6}/)?.[0];
    expect(code).toBeDefined();

    const verified = await request(app.getHttpServer())
      .post('/auth/otp/verify')
      .send({ phone, deviceId, platform: 'web', code })
      .expect(201);

    await request(app.getHttpServer())
      .get('/me')
      .set('Authorization', `Bearer ${verified.body.accessToken as string}`)
      .expect(200)
      .expect((response) => {
        expect(response.body.phone).toBe(`+57${phone}`);
      });
  });

  it('rejects a missing or invalid webhook secret', async () => {
    await request(app.getHttpServer())
      .post('/webhooks/telegram')
      .send(privateUpdate(1100, { text: '/start' }))
      .expect(401);
    await request(app.getHttpServer())
      .post('/webhooks/telegram')
      .set('X-Telegram-Bot-Api-Secret-Token', 'wrong')
      .send(privateUpdate(1101, { text: '/start' }))
      .expect(401);
  });

  it('ignores messages from group chats', async () => {
    const before = messaging.sent.length;
    await request(app.getHttpServer())
      .post('/webhooks/telegram')
      .set('X-Telegram-Bot-Api-Secret-Token', secret())
      .send({
        update_id: 1200,
        message: {
          message_id: 1,
          date: 1_767_225_600,
          chat: { id: -100, type: 'group' },
          from: { id: 900001, is_bot: false },
          text: '/start',
        },
      })
      .expect(200);
    await flush();
    expect(messaging.sent).toHaveLength(before);
  });

  it('rejects bodies above the webhook limit', async () => {
    await request(app.getHttpServer())
      .post('/webhooks/telegram')
      .set('X-Telegram-Bot-Api-Secret-Token', secret())
      .send(privateUpdate(1300, { text: 'x'.repeat(70 * 1024) }))
      .expect(413);
  });
});
