import type { NotificationPreferences, PlannedDelivery } from '../domain/notification.js';
import type {
  ChannelSendResult,
  DueDelivery,
  InboxEntry,
  NotificationChannelPort,
  NotificationRepository,
  RecipientContact,
} from '../ports/notifications-ports.js';
import { NotificationsService, type NotifiableEvent } from './notifications-service.js';

const now = new Date('2026-11-24T17:00:00.000Z');
const orderId = '018f47a2-8b45-7cc2-9a1e-123456789abc';
const ids = {
  buyer: '018f47a2-8b45-7cc2-9a1e-00000000000b',
  provider: '018f47a2-8b45-7cc2-9a1e-00000000000c',
  operator: '018f47a2-8b45-7cc2-9a1e-00000000000d',
};

const harness = () => {
  const inbox = new Map<string, InboxEntry>();
  const plans = new Map<string, readonly PlannedDelivery[]>();
  const due: DueDelivery[] = [];
  const completed: Parameters<NotificationRepository['completeDelivery']>[0][] = [];
  const changes: unknown[] = [];
  const repository: NotificationRepository = {
    insertNotification: async (entry, deliveries) => {
      if ([...inbox.values()].some((e) => e.eventId === entry.eventId && e.userId === entry.userId))
        return false;
      inbox.set(entry.id, entry);
      plans.set(entry.id, deliveries);
      return true;
    },
    findPreferences: async () => new Map<string, NotificationPreferences>(),
    savePreferences: async () => undefined,
    listInbox: async (userId) => [...inbox.values()].filter((e) => e.userId === userId),
    findInboxEntry: async (id) => inbox.get(id) ?? null,
    markRead: async (id, userId, at) => {
      const entry = inbox.get(id);
      if (!entry || entry.userId !== userId) return null;
      const read = { ...entry, readAt: entry.readAt ?? at };
      inbox.set(id, read);
      return read;
    },
    claimDue: async () => due.splice(0),
    completeDelivery: async (input) => {
      completed.push(input);
      return true;
    },
  };
  const contacts = new Map<string, RecipientContact>(
    Object.values(ids).map((userId) => [
      userId,
      {
        userId,
        locale: 'es-CO',
        messaging: { channel: 'telegram', channelUserId: `chat-${userId}` },
      },
    ]),
  );
  let sendResult: ChannelSendResult | Error = { ok: true };
  const messaging: NotificationChannelPort = {
    channel: 'messaging',
    enabled: true,
    canReach: (contact) => contact.messaging !== null,
    send: async () => {
      if (sendResult instanceof Error) throw sendResult;
      return sendResult;
    },
  };
  let sequence = 0;
  const service = new NotificationsService(
    repository,
    {
      orderParties: async (id) =>
        id === orderId ? { buyerId: ids.buyer, providerId: ids.provider } : null,
      activeOperatorIds: async () => [ids.operator],
      contacts: async (userIds) => userIds.flatMap((id) => contacts.get(id) ?? []),
    },
    [messaging],
    { record: async (change) => void changes.push(change) },
    { run: async (operation) => operation() },
    { now: () => now },
    { maxAttempts: 3, retryBaseSeconds: 30, retryMaxSeconds: 600, leaseSeconds: 60 },
    () => `018f47a2-8b45-7cc2-9a1e-${String((sequence += 1)).padStart(12, '0')}`,
  );
  const event = (type: string, payload: Record<string, unknown> = {}): NotifiableEvent => ({
    id: `event-${type}`,
    type,
    aggregate: `order:${orderId}`,
    payload,
  });
  return {
    service,
    inbox,
    plans,
    due,
    completed,
    changes,
    contacts,
    event,
    setSendResult: (result: ChannelSendResult | Error) => {
      sendResult = result;
    },
  };
};

describe('NotificationsService', () => {
  it.each([
    ['OrderAccepted', {}, [[ids.provider, 'order_received']]],
    ['OrderPickupScheduled', {}, [[ids.buyer, 'pickup_scheduled']]],
    ['OrderInTransit', {}, [[ids.buyer, 'in_transit']]],
    ['OrderDelivered', {}, [[ids.buyer, 'delivered']]],
    ['PaymentRejected', { orderId }, [[ids.buyer, 'payment_rejected']]],
    [
      'PaymentVerified',
      { orderId },
      [
        [ids.buyer, 'payment_verified_buyer'],
        [ids.provider, 'payment_verified_provider'],
      ],
    ],
    [
      'SettlementIssued',
      { orderId, beneficiaryId: ids.provider, amount: '950' },
      [[ids.provider, 'settlement_issued']],
    ],
    [
      'SettlementPaid',
      { orderId, beneficiaryId: ids.provider },
      [[ids.provider, 'settlement_paid']],
    ],
    ['IncidentOpened', { orderId }, [[ids.operator, 'incident_opened']]],
  ])('routes %s to its recipients', async (type, payload, expected) => {
    const h = harness();
    expect(await h.service.handleEvent(h.event(type, payload))).toBe(expected.length);
    expect([...h.inbox.values()].map((entry) => [entry.userId, entry.kind])).toEqual(expected);
    expect(h.changes).toHaveLength(expected.length);
  });

  it('ignores events without an order, unknown orders, unknown types and inactive users', async () => {
    const h = harness();
    expect(
      await h.service.handleEvent({
        id: 'e1',
        type: 'OrderAccepted',
        aggregate: 'lot:x',
        payload: {},
      }),
    ).toBe(0);
    expect(
      await h.service.handleEvent({
        id: 'e2',
        type: 'OrderAccepted',
        aggregate: 'order:018f47a2-8b45-7cc2-9a1e-ffffffffffff',
        payload: {},
      }),
    ).toBe(0);
    expect(await h.service.handleEvent(h.event('LotPublished'))).toBe(0);
    expect(await h.service.handleEvent(h.event('SettlementPaid', { orderId }))).toBe(0);
    h.contacts.delete(ids.provider);
    expect(await h.service.handleEvent(h.event('OrderAccepted'))).toBe(0);
  });

  it('is idempotent per event and user', async () => {
    const h = harness();
    await h.service.handleEvent(h.event('OrderAccepted'));
    expect(await h.service.handleEvent(h.event('OrderAccepted'))).toBe(0);
    expect(h.inbox.size).toBe(1);
  });

  it('sends, retries with backoff, stops after maxAttempts and handles thrown errors', async () => {
    const h = harness();
    await h.service.handleEvent(h.event('OrderAccepted'));
    const [entry] = [...h.inbox.values()];
    const delivery = (attempts: number): DueDelivery => ({
      id: 'delivery',
      inboxId: entry!.id,
      userId: ids.provider,
      channel: 'messaging',
      attempts,
      leaseToken: 'lease',
    });

    h.due.push(delivery(0));
    expect(await h.service.sendDue()).toEqual({ sent: 1, retried: 0, failed: 0 });

    h.setSendResult(new Error('network'));
    h.due.push(delivery(0));
    expect(await h.service.sendDue()).toEqual({ sent: 0, retried: 1, failed: 0 });
    expect(h.completed.at(-1)).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastError: 'channel_error',
      nextAttemptAt: new Date(now.getTime() + 30_000),
    });

    h.setSendResult({ ok: false, code: 'unavailable', retryable: true });
    h.due.push(delivery(2));
    expect(await h.service.sendDue()).toEqual({ sent: 0, retried: 0, failed: 1 });
    expect(h.completed.at(-1)).toMatchObject({
      status: 'failed',
      attempts: 3,
      nextAttemptAt: null,
    });
  });

  it('fails deliveries that can no longer be sent', async () => {
    const h = harness();
    await h.service.handleEvent(h.event('OrderAccepted'));
    const [entry] = [...h.inbox.values()];
    h.due.push(
      {
        id: 'a',
        inboxId: 'missing',
        userId: ids.provider,
        channel: 'messaging',
        attempts: 0,
        leaseToken: 'l',
      },
      {
        id: 'b',
        inboxId: entry!.id,
        userId: ids.provider,
        channel: 'push',
        attempts: 0,
        leaseToken: 'l',
      },
    );
    h.contacts.set(ids.buyer, { userId: ids.buyer, locale: 'es-CO', messaging: null });
    h.due.push({
      id: 'c',
      inboxId: entry!.id,
      userId: ids.buyer,
      channel: 'messaging',
      attempts: 0,
      leaseToken: 'l',
    });
    expect(await h.service.sendDue()).toEqual({ sent: 0, retried: 0, failed: 3 });
    expect(h.completed.map(({ lastError }) => lastError)).toEqual([
      'notification_missing',
      'channel_disabled',
      'recipient_unreachable',
    ]);
  });

  it('marks only the owner notice read and records the change once', async () => {
    const h = harness();
    await h.service.handleEvent(h.event('OrderAccepted'));
    const [entry] = [...h.inbox.values()];
    await expect(h.service.markRead(ids.buyer, entry!.id)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(h.service.markRead(ids.provider, 'missing')).rejects.toMatchObject({
      code: 'not_found',
    });
    const read = await h.service.markRead(ids.provider, entry!.id);
    expect(read.readAt).toEqual(now);
    await h.service.markRead(ids.provider, entry!.id);
    expect(h.changes).toHaveLength(2);
  });

  it('pages with a cursor and rejects a malformed one', async () => {
    const h = harness();
    await h.service.handleEvent(h.event('PaymentVerified', { orderId }));
    await h.service.handleEvent({ ...h.event('OrderAccepted'), id: 'event-2' });
    const first = await h.service.listInbox(ids.provider, undefined, 1);
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toEqual(expect.any(String));
    await h.service.listInbox(ids.provider, first.nextCursor, 1);
    for (const cursor of ['x'.repeat(201), Buffer.from('nope|x').toString('base64url')])
      await expect(h.service.listInbox(ids.provider, cursor, 1)).rejects.toMatchObject({
        code: 'invalid_cursor',
      });
    expect(await h.service.getPreferences(ids.provider)).toEqual({
      channelOrder: ['messaging', 'push', 'sms'],
      quietHours: null,
    });
    await expect(
      h.service.savePreferences(ids.provider, { channelOrder: [], quietHours: null }),
    ).rejects.toMatchObject({ code: 'invalid_channel_order' });
  });
});
