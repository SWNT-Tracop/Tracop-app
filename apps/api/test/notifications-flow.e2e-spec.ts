import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import request from 'supertest';
import { AppModule } from '../src/bootstrap/app.module.js';
import { InMemoryOtpSender } from '../src/modules/identity/adapters/out/otp-senders.js';
import { OTP_SENDER } from '../src/modules/identity/ports/tokens.js';
import { MESSAGING_PORT, type MessagingError } from '../src/modules/messaging/index.js';
import {
  NOTIFICATIONS_MAINTENANCE,
  NOTIFICATIONS_OUTBOX_SUBSCRIBER,
  type NotificationsMaintenanceApi,
} from '../src/modules/notifications/index.js';
import { InMemoryStorageAdapter } from '../src/shared/infra/storage/in-memory-storage.adapter.js';
import { DATABASE_POOL } from '../src/shared/infra/tokens.js';
import { createId } from '../src/shared/kernel/ids.js';
import { failure, success, type Result } from '../src/shared/kernel/result.js';
import type {
  OutboxEventRecord,
  OutboxSubscriberPort,
} from '../src/shared/ports/outbox-subscriber.js';
import { STORAGE_PORT } from '../src/shared/ports/storage.js';
import { createStaffAccount } from './helpers/staff-account.js';
import { createSyntheticJpeg } from './helpers/synthetic-image.js';
import { describePostgres, resetPostgresFixtures } from './postgres-suite.js';

type Account = { readonly token: string; readonly userId: string };

/** A MessagingPort whose next answers can be scripted; it records what it sent. */
class ScriptedMessaging {
  readonly sent: { readonly channelUserId: string; readonly text: string }[] = [];
  readonly failures: MessagingError[] = [];

  async sendText(
    to: { readonly channelUserId: string },
    text: string,
  ): Promise<Result<void, MessagingError>> {
    const scripted = this.failures.shift();
    if (scripted) return failure(scripted);
    this.sent.push({ channelUserId: to.channelUserId, text });
    return success(undefined);
  }

  async sendButtons(): Promise<Result<void, MessagingError>> {
    return success(undefined);
  }
}

describePostgres('notifications (Nest + PostgreSQL)', () => {
  let app: INestApplication;
  let pool: pg.Pool;
  let otpSender: InMemoryOtpSender;
  let messaging: ScriptedMessaging;
  let subscriber: OutboxSubscriberPort;
  let maintenance: NotificationsMaintenanceApi;
  let phoneSequence = 1;
  let productId: string;

  const http = () => request(app.getHttpServer());
  const bearer = (account: Account) => ({ Authorization: `Bearer ${account.token}` });
  const nextPhone = () => `306${String(phoneSequence++).padStart(7, '0')}`;

  const register = async (role: 'buyer' | 'supplier'): Promise<Account> => {
    const phone = nextPhone();
    const deviceId = createId();
    await http()
      .post('/auth/register')
      .send({
        phone,
        role,
        fullName: `Persona ${role}`,
        deviceId,
        platform: 'web',
        consent: { accepted: true, version: 'v0-draft' },
      })
      .expect(201);
    const verified = await http()
      .post('/auth/otp/verify')
      .send({ phone, deviceId, platform: 'web', code: otpSender.sent.at(-1)?.code })
      .expect(201);
    return { token: verified.body.accessToken as string, userId: verified.body.user.id as string };
  };

  const linkTelegram = async (userId: string, chatId: string) => {
    await pool.query(
      `INSERT INTO identity.channel_links (id, user_id, channel, channel_user_id, verified_at, created_at)
       VALUES ($1, $2, 'telegram', $3, now(), now())`,
      [createId(), userId, chatId],
    );
  };

  /** A supplier (linked to Telegram) with a lot and a buyer whose order was accepted. */
  const acceptedOrder = async () => {
    const supplier = await register('supplier');
    const buyer = await register('buyer');
    await linkTelegram(supplier.userId, `chat-${supplier.userId.slice(0, 8)}`);
    await http()
      .put('/me/provider-profile')
      .set(bearer(supplier))
      .send({
        displayName: 'Finca sintética',
        municipality: 'Tunja',
        department: 'Boyacá',
        lat: 5.53,
        lng: -73.36,
        description: 'Dato sintético',
      })
      .expect(200);
    const lotId = createId();
    await http()
      .post('/lots')
      .set(bearer(supplier))
      .send({
        id: lotId,
        productId,
        quantityMilli: '10000',
        unit: 'kg',
        unitPrice: 4_500,
        qualityGrade: null,
        availableFrom: new Date(Date.now() - 3_600_000).toISOString(),
        availableUntil: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        locationLat: 5.53,
        locationLng: -73.36,
      })
      .expect(201);
    await http()
      .post(`/lots/${lotId}/publish`)
      .set(bearer(supplier))
      .send({ version: 1 })
      .expect(201);
    const orderId = createId();
    const created = await http()
      .post('/orders')
      .set(bearer(buyer))
      .send({
        id: orderId,
        lines: [{ lotId, quantityMilli: '2000' }],
        deliveryAddress: 'Calle 1 # 2-3, Chapinero, Bogotá',
      })
      .expect(201);
    await http()
      .post(`/orders/${orderId}/accept`)
      .set(bearer(buyer))
      .send({ expectedVersion: created.body.version })
      .expect(200);
    return { supplier, buyer, orderId };
  };

  const outboxEvents = async (type: string): Promise<OutboxEventRecord[]> =>
    (
      await pool.query<{
        id: string;
        aggregate: string;
        type: string;
        payload: Record<string, unknown>;
        created_at: Date;
        attempts: number;
      }>(
        `SELECT id, aggregate, type, payload, created_at, attempts FROM shared.outbox_events
         WHERE type = $1 ORDER BY created_at, id`,
        [type],
      )
    ).rows.map((row) => ({
      id: row.id,
      aggregate: row.aggregate,
      type: row.type,
      payload: row.payload,
      createdAt: row.created_at,
      attempts: row.attempts,
    }));

  const deliveries = async (userId: string) =>
    (
      await pool.query<{
        channel: string;
        status: string;
        attempts: number;
        last_error: string | null;
        next_attempt_at: Date | null;
      }>(
        `SELECT channel, status, attempts, last_error, next_attempt_at
         FROM notifications.deliveries WHERE user_id = $1 ORDER BY created_at, channel`,
        [userId],
      )
    ).rows;

  const inbox = async (account: Account) =>
    (await http().get('/me/inbox').set(bearer(account)).expect(200)).body as {
      items: { id: string; kind: string; title: string; body: string; readAt: string | null }[];
    };

  beforeAll(async () => {
    const sender = new InMemoryOtpSender();
    messaging = new ScriptedMessaging();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(OTP_SENDER)
      .useValue(sender)
      .overrideProvider(MESSAGING_PORT)
      .useValue(messaging)
      .compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
    pool = app.get(DATABASE_POOL) as pg.Pool;
    otpSender = sender;
    subscriber = app.get<OutboxSubscriberPort>(NOTIFICATIONS_OUTBOX_SUBSCRIBER);
    maintenance = app.get<NotificationsMaintenanceApi>(NOTIFICATIONS_MAINTENANCE);
  });

  beforeEach(async () => {
    await resetPostgresFixtures(pool);
    otpSender.sent.length = 0;
    messaging.sent.length = 0;
    messaging.failures.length = 0;
    phoneSequence = 1;
    const categoryId = createId();
    productId = createId();
    await pool.query(
      `INSERT INTO catalog.categories (id, name, parent_id, depth, created_at, updated_at)
       VALUES ($1, 'Tubérculos', NULL, 1, now(), now())`,
      [categoryId],
    );
    await pool.query(
      `INSERT INTO catalog.products (id, category_id, name, search_text, unit, attributes, created_at, updated_at)
       VALUES ($1, $2, 'Papa criolla', 'papa criolla', 'kg', '{}', now(), now())`,
      [productId, categoryId],
    );
  });

  afterAll(async () => app.close());

  it('tells the provider about an accepted order by Telegram and in the inbox, once', async () => {
    const { supplier, buyer, orderId } = await acceptedOrder();
    const [accepted] = await outboxEvents('OrderAccepted');

    // At-least-once delivery, even concurrently: one notice.
    await Promise.all([subscriber.handle(accepted!), subscriber.handle(accepted!)]);
    await subscriber.handle(accepted!);

    const ref = `#${orderId.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
    const supplierInbox = await inbox(supplier);
    expect(supplierInbox.items).toEqual([
      {
        id: expect.any(String),
        kind: 'order_received',
        title: 'Nuevo pedido',
        body: `Un comprador aceptó el pedido ${ref}. Prepara el lote para la recogida.`,
        createdAt: expect.any(String),
        readAt: null,
      },
    ]);
    expect((await inbox(buyer)).items).toEqual([]);
    expect(await deliveries(supplier.userId)).toEqual([
      expect.objectContaining({ channel: 'messaging', status: 'pending', attempts: 0 }),
    ]);

    expect(await maintenance.sendDueNotifications()).toEqual({ sent: 1, retried: 0, failed: 0 });
    expect(messaging.sent).toEqual([
      {
        channelUserId: `chat-${supplier.userId.slice(0, 8)}`,
        text: `Nuevo pedido\nUn comprador aceptó el pedido ${ref}. Prepara el lote para la recogida.`,
      },
    ]);
    expect(await maintenance.sendDueNotifications()).toEqual({ sent: 0, retried: 0, failed: 0 });
    expect(await deliveries(supplier.userId)).toEqual([
      expect.objectContaining({ channel: 'messaging', status: 'sent', attempts: 1 }),
    ]);
  });

  it('records push as skipped and keeps only the inbox for a user without a linked channel', async () => {
    const { buyer } = await acceptedOrder();
    const finance = await createStaffAccount(app, pool, 'finance', `+57${nextPhone()}`);
    const orderId = (await pool.query<{ id: string }>(`SELECT id FROM ordering.orders`)).rows[0]!
      .id;
    const payment = await http()
      .post(`/orders/${orderId}/payment`)
      .set(bearer(buyer))
      .send({ id: createId(), method: 'nequi' })
      .expect(201);
    const policy = await http()
      .post(`/payments/${payment.body.id}/proof`)
      .set(bearer(buyer))
      .expect(201);
    const storage = app.get(STORAGE_PORT) as InMemoryStorageAdapter;
    await storage.putObject({
      key: policy.body.uploadPolicy.fields.key,
      body: await createSyntheticJpeg(),
      contentType: 'image/jpeg',
    });
    const confirmed = await http()
      .post(`/payments/${payment.body.id}/proof/confirm`)
      .set(bearer(buyer))
      .expect(200);
    await http()
      .post(`/payments/${payment.body.id}/reject`)
      .set(bearer(finance))
      .send({ expectedVersion: confirmed.body.version, reason: 'Ilegible' })
      .expect(200);

    for (const event of await outboxEvents('PaymentRejected')) await subscriber.handle(event);

    expect((await inbox(buyer)).items.map(({ kind }) => kind)).toEqual(['payment_rejected']);
    // Critical: push is tried (no provider, skipped) and SMS too, but nothing can reach the buyer.
    expect(await deliveries(buyer.userId)).toEqual([
      expect.objectContaining({ channel: 'push', status: 'skipped' }),
      expect.objectContaining({ channel: 'sms', status: 'skipped' }),
    ]);
  });

  it('retries a failed send with backoff and gives up on a blocked recipient', async () => {
    const { supplier } = await acceptedOrder();
    for (const event of await outboxEvents('OrderAccepted')) await subscriber.handle(event);

    messaging.failures.push({ kind: 'unavailable', retryable: true });
    expect(await maintenance.sendDueNotifications()).toEqual({ sent: 0, retried: 1, failed: 0 });
    const [retrying] = await deliveries(supplier.userId);
    expect(retrying).toMatchObject({ status: 'pending', attempts: 1, last_error: 'unavailable' });
    expect(retrying!.next_attempt_at!.getTime()).toBeGreaterThan(Date.now() + 20_000);
    // Not due yet.
    expect(await maintenance.sendDueNotifications()).toEqual({ sent: 0, retried: 0, failed: 0 });

    await pool.query(
      `UPDATE notifications.deliveries SET next_attempt_at = now() - interval '1 second' WHERE user_id = $1`,
      [supplier.userId],
    );
    messaging.failures.push({ kind: 'blocked_by_user' });
    expect(await maintenance.sendDueNotifications()).toEqual({ sent: 0, retried: 0, failed: 1 });
    expect(await deliveries(supplier.userId)).toEqual([
      expect.objectContaining({ status: 'failed', attempts: 2, last_error: 'blocked_by_user' }),
    ]);
    expect(messaging.sent).toEqual([]);
  });

  it('holds non-critical notices during quiet hours', async () => {
    const supplier = await register('supplier');
    // A two-hour window around the current Bogotá time (it may cross midnight).
    const bogotaTime = (offsetMinutes: number) =>
      new Date(Date.now() + (offsetMinutes - 5 * 60) * 60_000).toISOString().slice(11, 16);
    const quietHours = { start: bogotaTime(-60), end: bogotaTime(60) };
    const saved = await http()
      .put('/me/notification-preferences')
      .set(bearer(supplier))
      .send({ channelOrder: ['messaging'], quietHours })
      .expect(200);
    expect(saved.body).toEqual({ channelOrder: ['messaging'], quietHours });
    await http()
      .put('/me/notification-preferences')
      .set(bearer(supplier))
      .send({ channelOrder: ['sms', 'sms'], quietHours: null })
      .expect(400);
    expect(
      (await http().get('/me/notification-preferences').set(bearer(supplier)).expect(200)).body,
    ).toEqual(saved.body);
    await linkTelegram(supplier.userId, 'chat-quiet');
    const event: OutboxEventRecord = {
      id: createId(),
      aggregate: `payment:${createId()}`,
      type: 'SettlementIssued',
      payload: { orderId: createId(), beneficiaryId: supplier.userId, amount: '45000' },
      createdAt: new Date(),
      attempts: 0,
    };

    await subscriber.handle(event);

    const [delivery] = await deliveries(supplier.userId);
    expect(delivery).toMatchObject({ channel: 'messaging', status: 'pending' });
    expect(delivery!.next_attempt_at!.getTime()).toBeGreaterThan(Date.now());
    expect(await maintenance.sendDueNotifications()).toEqual({ sent: 0, retried: 0, failed: 0 });
    expect((await inbox(supplier)).items[0]!.body).toMatch(/\$45\.000 COP\.$/);
  });

  it('sends each due notice once when two workers run together', async () => {
    const { supplier } = await acceptedOrder();
    for (const event of await outboxEvents('OrderAccepted')) await subscriber.handle(event);

    const results = await Promise.all([
      maintenance.sendDueNotifications(),
      maintenance.sendDueNotifications(),
    ]);

    expect(results.reduce((sum, result) => sum + result.sent, 0)).toBe(1);
    expect(messaging.sent).toHaveLength(1);
    expect(await deliveries(supplier.userId)).toEqual([
      expect.objectContaining({ status: 'sent', attempts: 1 }),
    ]);
  });

  it('lets only the owner read a notice, and syncs it for the owner only', async () => {
    const { supplier, buyer } = await acceptedOrder();
    for (const event of await outboxEvents('OrderAccepted')) await subscriber.handle(event);
    const [entry] = (await inbox(supplier)).items;

    await http().post(`/me/inbox/${entry!.id}/read`).set(bearer(buyer)).expect(404);
    const read = await http().post(`/me/inbox/${entry!.id}/read`).set(bearer(supplier)).expect(200);
    expect(read.body.readAt).toEqual(expect.any(String));
    const again = await http()
      .post(`/me/inbox/${entry!.id}/read`)
      .set(bearer(supplier))
      .expect(200);
    expect(again.body.readAt).toBe(read.body.readAt);

    const pulled = async (account: Account) =>
      (
        (await http().get('/sync/pull').set(bearer(account)).expect(200)).body.changes as {
          entity: string;
          entityId: string;
          payload: { readAt: string | null };
        }[]
      ).filter(({ entity }) => entity === 'notification');
    const supplierChanges = await pulled(supplier);
    expect(supplierChanges.map(({ entityId }) => entityId)).toEqual([entry!.id, entry!.id]);
    expect(supplierChanges.at(-1)!.payload.readAt).toBe(read.body.readAt);
    expect(await pulled(buyer)).toEqual([]);
  });

  it('pages the inbox newest first with an opaque cursor', async () => {
    const supplier = await register('supplier');
    for (let index = 0; index < 3; index += 1)
      await subscriber.handle({
        id: createId(),
        aggregate: `payment:${createId()}`,
        type: 'SettlementPaid',
        payload: { orderId: createId(), beneficiaryId: supplier.userId, amount: String(index) },
        createdAt: new Date(),
        attempts: 0,
      });

    const first = await http().get('/me/inbox?limit=2').set(bearer(supplier)).expect(200);
    expect(first.body.items).toHaveLength(2);
    const second = await http()
      .get(`/me/inbox?limit=2&cursor=${first.body.nextCursor as string}`)
      .set(bearer(supplier))
      .expect(200);
    expect(second.body.items).toHaveLength(1);
    expect(second.body).not.toHaveProperty('nextCursor');
    const ids = [...first.body.items, ...second.body.items].map((item: { id: string }) => item.id);
    expect(new Set(ids).size).toBe(3);
    await http().get('/me/inbox?cursor=bm90LWEtY3Vyc29y').set(bearer(supplier)).expect(400);
  });
});
