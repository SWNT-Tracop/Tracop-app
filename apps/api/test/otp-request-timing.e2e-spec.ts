import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/bootstrap/app.module.js';
import { describePostgres } from './postgres-suite.js';
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
import { APP_ENVIRONMENT, APP_LOGGER, BACKGROUND_DISPATCHER } from '../src/shared/infra/tokens.js';
import type { BackgroundDispatcher } from '../src/shared/ports/background-dispatcher.js';
import { loadAppEnvironment } from '../src/shared/infra/env.js';
import type pino from 'pino';
import { FakeMessagingAdapter } from './support/fake-messaging.js';

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const secret = (): string => process.env.TELEGRAM_WEBHOOK_SECRET ?? '';

class ControlledTelegramOtpSender extends TelegramOtpSender {
  private releasePromise: (() => void) | undefined;
  private readonly gate: Promise<void>;
  sendStarted = false;

  constructor(identity: IdentityChannelApplication, port: MessagingPort, logger: pino.Logger) {
    super(identity, port, logger);
    this.gate = new Promise<void>((resolve) => {
      this.releasePromise = resolve;
    });
  }

  override async send(phone: unknown, code: string): Promise<void> {
    this.sendStarted = true;
    await this.gate;
    return super.send(phone as never, code);
  }

  release(): void {
    this.releasePromise?.();
  }
}

describePostgres('OTP request timing', () => {
  let app: INestApplication;
  let messaging: FakeMessagingAdapter;
  let sender: ControlledTelegramOtpSender;
  const linkedPhone = '3012223333';
  const unlinkedPhone = '3014445555';
  const linkedDeviceId = randomUUID();
  const unlinkedDeviceId = randomUUID();

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
        factory: (
          identity: IdentityChannelApplication,
          port: MessagingPort,
          logger: pino.Logger,
        ) => {
          sender = new ControlledTelegramOtpSender(identity, port, logger);
          return sender;
        },
      })
      .compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    configureHttp(app);
    await app.listen(0, '127.0.0.1');
    expect(app.get(OTP_SENDER)).toBeInstanceOf(ControlledTelegramOtpSender);
  });

  afterAll(async () => {
    await app.close();
  });

  const registerUser = async (phone: string, deviceId: string): Promise<void> => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        phone,
        role: 'buyer',
        fullName: 'Comprador',
        deviceId,
        platform: 'web',
        consent: { accepted: true, version: 'v0-draft' },
      })
      .expect(201);
  };

  const linkChannel = async (phone: string, telegramUserId: number): Promise<void> => {
    await request(app.getHttpServer())
      .post('/webhooks/telegram')
      .set('X-Telegram-Bot-Api-Secret-Token', secret())
      .send({
        update_id: telegramUserId,
        message: {
          message_id: telegramUserId,
          date: 1_767_225_600,
          chat: { id: telegramUserId, type: 'private' },
          from: { id: telegramUserId, is_bot: false },
          contact: { phone_number: `+57${phone}`, user_id: telegramUserId },
        },
      })
      .expect(200);
    await flush();
    expect(messaging.sent.at(-1)?.text).toBe(messagingMessages.linked);
  };

  it('responds before the channel send resolves for a linked phone, same shape as unlinked', async () => {
    await registerUser(linkedPhone, linkedDeviceId);
    await linkChannel(linkedPhone, 901001);
    await registerUser(unlinkedPhone, unlinkedDeviceId);

    // The send gate is still closed when the responses arrive below, so a
    // resolved response proves the request finished before the send resolved.
    sender.sendStarted = false;

    const linked = await request(app.getHttpServer())
      .post('/auth/otp/request')
      .send({ phone: linkedPhone })
      .expect(201);

    expect(linked.body).toEqual({ message: expect.any(String), botLink: expect.any(String) });

    expect(sender.sendStarted).toBe(true);
    sender.release();
    await (app.get(BACKGROUND_DISPATCHER) as BackgroundDispatcher).flush();
    await flush();

    sender.sendStarted = false;

    const unlinked = await request(app.getHttpServer())
      .post('/auth/otp/request')
      .send({ phone: unlinkedPhone })
      .expect(201);

    expect(unlinked.body).toEqual(linked.body);
    expect(sender.sendStarted).toBe(true);
    sender.release();
    await (app.get(BACKGROUND_DISPATCHER) as BackgroundDispatcher).flush();
  });
});
