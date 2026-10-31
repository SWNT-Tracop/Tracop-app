import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { Pool } from 'pg';
import { AppModule } from '../src/bootstrap/app.module.js';
import { IdentityChannelAdapter } from '../src/bootstrap/identity-channel.adapter.js';
import {
  IDENTITY_CHANNEL_APPLICATION,
  type IdentityChannelApplication,
} from '../src/modules/identity/index.js';
import {
  CHANNEL_IDENTITY_PORT,
  MESSAGING_PORT,
  type ChannelIdentityPort,
  type ChannelUserRef,
  type LinkChannelOutcome,
} from '../src/modules/messaging/index.js';
import { DATABASE_POOL } from '../src/shared/infra/tokens.js';
import { FakeMessagingAdapter } from './support/fake-messaging.js';

class ControllableIdentityAdapter implements ChannelIdentityPort {
  failAfterLink = false;

  constructor(private readonly inner: IdentityChannelAdapter) {}

  async linkChannel(ref: ChannelUserRef, phone: string): Promise<LinkChannelOutcome> {
    const result = await this.inner.linkChannel(ref, phone);
    if (this.failAfterLink) throw new Error('forced failure after link');
    return result;
  }

  findActiveChannelByPhone(phone: string): Promise<ChannelUserRef | null> {
    return this.inner.findActiveChannelByPhone(phone);
  }
}

const contactUpdate = (updateId: number, channelUserId: number, phone: string) => ({
  update_id: updateId,
  message: {
    message_id: updateId,
    date: 1_767_225_600,
    chat: { id: channelUserId, type: 'private' },
    from: { id: channelUserId, is_bot: false },
    contact: { phone_number: phone, user_id: channelUserId },
  },
});

describe('messaging transaction boundaries', () => {
  let app: INestApplication;
  let pool: Pool;
  let control: ControllableIdentityAdapter;
  const phone = '3019876543';
  const deviceId = randomUUID();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MESSAGING_PORT)
      .useValue(new FakeMessagingAdapter())
      .overrideProvider(CHANNEL_IDENTITY_PORT)
      .useFactory({
        inject: [IDENTITY_CHANNEL_APPLICATION],
        factory: (identity: IdentityChannelApplication) =>
          new ControllableIdentityAdapter(new IdentityChannelAdapter(identity)),
      })
      .compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
    pool = app.get(DATABASE_POOL) as Pool;
    control = app.get(CHANNEL_IDENTITY_PORT) as ControllableIdentityAdapter;

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
  });

  afterAll(async () => {
    await app.close();
  });

  it('rolls back the update claim and the link when a technical failure occurs', async () => {
    control.failAfterLink = true;
    await request(app.getHttpServer())
      .post('/webhooks/telegram')
      .set('X-Telegram-Bot-Api-Secret-Token', process.env.TELEGRAM_WEBHOOK_SECRET ?? '')
      .send(contactUpdate(2001, 910001, phone))
      .expect(500);

    const processed = await pool.query<{ count: string }>(
      'SELECT count(*) FROM messaging.processed_updates WHERE update_id = $1',
      [2001],
    );
    const links = await pool.query<{ count: string }>(
      'SELECT count(*) FROM identity.channel_links WHERE channel_user_id = $1',
      ['910001'],
    );
    expect(processed.rows[0]?.count).toBe('0');
    expect(links.rows[0]?.count).toBe('0');

    control.failAfterLink = false;
    await request(app.getHttpServer())
      .post('/webhooks/telegram')
      .set('X-Telegram-Bot-Api-Secret-Token', process.env.TELEGRAM_WEBHOOK_SECRET ?? '')
      .send(contactUpdate(2001, 910001, phone))
      .expect(200);

    const retriedProcessed = await pool.query<{ count: string }>(
      'SELECT count(*) FROM messaging.processed_updates WHERE update_id = $1',
      [2001],
    );
    const retriedLinks = await pool.query<{ count: string }>(
      'SELECT count(*) FROM identity.channel_links WHERE channel_user_id = $1',
      ['910001'],
    );
    expect(retriedProcessed.rows[0]?.count).toBe('1');
    expect(retriedLinks.rows[0]?.count).toBe('1');
  });

  it('commits the update id after a business rejection', async () => {
    await request(app.getHttpServer())
      .post('/webhooks/telegram')
      .set('X-Telegram-Bot-Api-Secret-Token', process.env.TELEGRAM_WEBHOOK_SECRET ?? '')
      .send(contactUpdate(2002, 910002, '3000000000'))
      .expect(200);

    const processed = await pool.query<{ count: string }>(
      'SELECT count(*) FROM messaging.processed_updates WHERE update_id = $1',
      [2002],
    );
    const links = await pool.query<{ count: string }>(
      'SELECT count(*) FROM identity.channel_links WHERE channel_user_id = $1',
      ['910002'],
    );
    expect(processed.rows[0]?.count).toBe('1');
    expect(links.rows[0]?.count).toBe('0');
  });
});
