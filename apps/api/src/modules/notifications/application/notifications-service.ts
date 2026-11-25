import { DomainError } from '../../../shared/kernel/domain-error.js';
import {
  DEFAULT_PREFERENCES,
  planDeliveries,
  retryDelaySeconds,
  validatePreferences,
  type DeliveryChannel,
  type NotificationKind,
  type NotificationPreferences,
} from '../domain/notification.js';
import {
  TEMPLATE_VERSION,
  formatCop,
  orderReference,
  renderNotification,
} from '../domain/templates.js';
import type {
  InboxEntry,
  NotificationChangeRecorder,
  NotificationChannelPort,
  NotificationRepository,
  NotificationsClock,
  NotificationsSettings,
  NotificationsUnitOfWork,
  RecipientContact,
  RecipientDirectoryPort,
} from '../ports/notifications-ports.js';

export interface NotifiableEvent {
  readonly id: string;
  readonly type: string;
  readonly aggregate: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** The outbox event types that produce notifications. */
export const NOTIFIED_EVENT_TYPES = [
  'OrderAccepted',
  'OrderPickupScheduled',
  'OrderInTransit',
  'OrderDelivered',
  'PaymentVerified',
  'PaymentRejected',
  'SettlementIssued',
  'SettlementPaid',
  'IncidentOpened',
  'PriceAlertMatched',
] as const;

type Recipient = { readonly userId: string; readonly kind: NotificationKind };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORDER_AGGREGATE = /^order:([0-9a-f-]{36})$/i;
const MAX_CURSOR_LENGTH = 200;

const uuidOrNull = (value: unknown): string | null =>
  typeof value === 'string' && UUID.test(value) ? value : null;

export interface InboxPage {
  readonly items: readonly InboxEntry[];
  readonly nextCursor?: string;
}

export class NotificationsService {
  private readonly channels: ReadonlyMap<DeliveryChannel, NotificationChannelPort>;

  constructor(
    private readonly repository: NotificationRepository,
    private readonly directory: RecipientDirectoryPort,
    channels: readonly NotificationChannelPort[],
    private readonly changes: NotificationChangeRecorder,
    private readonly uow: NotificationsUnitOfWork,
    private readonly clock: NotificationsClock,
    private readonly settings: NotificationsSettings,
    private readonly newId: () => string,
  ) {
    this.channels = new Map(channels.map((channel) => [channel.channel, channel]));
  }

  /**
   * Outbox consumer: writes one inbox entry and its delivery plan per recipient. Idempotent per
   * (event, user), as at-least-once delivery requires. Returns how many notices it created.
   */
  async handleEvent(event: NotifiableEvent): Promise<number> {
    // A price alert is not about an order: its only recipient is the alert's buyer.
    const alertBuyer =
      event.type === 'PriceAlertMatched' ? uuidOrNull(event.payload.buyerId) : null;
    if (event.type === 'PriceAlertMatched' && !alertBuyer) return 0;
    const orderId = alertBuyer
      ? null
      : (uuidOrNull(event.payload.orderId) ?? ORDER_AGGREGATE.exec(event.aggregate)?.[1] ?? null);
    if (!alertBuyer && !orderId) return 0;
    const recipients: readonly Recipient[] = alertBuyer
      ? [{ userId: alertBuyer, kind: 'lot_alert' }]
      : await this.recipientsFor(event, orderId!);
    if (!recipients.length) return 0;
    const contacts = new Map(
      (await this.directory.contacts(recipients.map(({ userId }) => userId))).map((contact) => [
        contact.userId,
        contact,
      ]),
    );
    const preferences = await this.repository.findPreferences([...contacts.keys()]);
    const amount = typeof event.payload.amount === 'string' ? event.payload.amount : undefined;
    let created = 0;
    for (const recipient of recipients) {
      const contact = contacts.get(recipient.userId);
      if (!contact) continue; // Inactive or unknown users are not notified.
      const now = this.clock.now();
      const rendered = renderNotification(recipient.kind, contact.locale, {
        orderRef: orderId ? orderReference(orderId) : '',
        ...(amount && /^\d+$/.test(amount) ? { amount: formatCop(BigInt(amount)) } : {}),
      });
      const entry: InboxEntry = {
        id: this.newId(),
        userId: contact.userId,
        eventId: event.id,
        kind: recipient.kind,
        ...rendered,
        templateVersion: TEMPLATE_VERSION,
        createdAt: now,
        readAt: null,
      };
      const plan = planDeliveries({
        kind: recipient.kind,
        preferences: preferences.get(contact.userId) ?? DEFAULT_PREFERENCES,
        reachable: this.reachableChannels(contact),
        enabled: this.enabledChannels(),
        now,
      });
      const inserted = await this.uow.run(async () => {
        if (!(await this.repository.insertNotification(entry, plan))) return false;
        await this.recordChange(entry);
        return true;
      });
      if (inserted) created += 1;
    }
    return created;
  }

  /** Worker job: sends the due deliveries, retrying with backoff until maxAttempts. */
  async sendDue(
    limit = 100,
  ): Promise<{ readonly sent: number; readonly retried: number; readonly failed: number }> {
    const now = this.clock.now();
    const claimed = await this.repository.claimDue(
      now,
      new Date(now.getTime() + this.settings.leaseSeconds * 1000),
      limit,
    );
    const result = { sent: 0, retried: 0, failed: 0 };
    for (const delivery of claimed) {
      const attempts = delivery.attempts + 1;
      const outcome = await this.attempt(delivery.userId, delivery.inboxId, delivery.channel);
      const finishedAt = this.clock.now();
      const retry = !outcome.ok && outcome.retryable && attempts < this.settings.maxAttempts;
      const status = outcome.ok ? 'sent' : retry ? 'pending' : 'failed';
      await this.repository.completeDelivery({
        id: delivery.id,
        leaseToken: delivery.leaseToken,
        status,
        attempts,
        nextAttemptAt: retry
          ? new Date(
              finishedAt.getTime() +
                retryDelaySeconds(
                  attempts,
                  this.settings.retryBaseSeconds,
                  this.settings.retryMaxSeconds,
                ) *
                  1000,
            )
          : null,
        lastError: outcome.ok ? null : outcome.code,
        now: finishedAt,
      });
      if (status === 'sent') result.sent += 1;
      else if (status === 'pending') result.retried += 1;
      else result.failed += 1;
    }
    return result;
  }

  async getPreferences(userId: string): Promise<NotificationPreferences> {
    return (await this.repository.findPreferences([userId])).get(userId) ?? DEFAULT_PREFERENCES;
  }

  async savePreferences(
    userId: string,
    input: NotificationPreferences,
  ): Promise<NotificationPreferences> {
    const preferences = validatePreferences(input);
    await this.repository.savePreferences(userId, preferences, this.clock.now());
    return preferences;
  }

  async listInbox(userId: string, cursor: string | undefined, limit: number): Promise<InboxPage> {
    const position = cursor ? this.decodeCursor(cursor) : null;
    const rows = await this.repository.listInbox(userId, position, limit + 1);
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return rows.length > limit && last ? { items, nextCursor: this.encodeCursor(last) } : { items };
  }

  /** Marks the user's notice read; anyone else's id answers not_found. */
  async markRead(userId: string, inboxId: string): Promise<InboxEntry> {
    return this.uow.run(async () => {
      const before = await this.repository.findInboxEntry(inboxId);
      if (!before || before.userId !== userId)
        throw new DomainError('Notificación no encontrada.', 'not_found');
      const entry = await this.repository.markRead(inboxId, userId, this.clock.now());
      if (!entry) throw new DomainError('Notificación no encontrada.', 'not_found');
      if (!before.readAt) await this.recordChange(entry);
      return entry;
    });
  }

  private async recipientsFor(
    event: NotifiableEvent,
    orderId: string,
  ): Promise<readonly Recipient[]> {
    const toBuyer = async (kind: NotificationKind): Promise<Recipient[]> => {
      const parties = await this.directory.orderParties(orderId);
      return parties ? [{ userId: parties.buyerId, kind }] : [];
    };
    switch (event.type) {
      case 'OrderAccepted': {
        const parties = await this.directory.orderParties(orderId);
        return parties ? [{ userId: parties.providerId, kind: 'order_received' }] : [];
      }
      case 'OrderPickupScheduled':
        return toBuyer('pickup_scheduled');
      case 'OrderInTransit':
        return toBuyer('in_transit');
      case 'OrderDelivered':
        return toBuyer('delivered');
      case 'PaymentRejected':
        return toBuyer('payment_rejected');
      case 'PaymentVerified': {
        const parties = await this.directory.orderParties(orderId);
        return parties
          ? [
              { userId: parties.buyerId, kind: 'payment_verified_buyer' },
              { userId: parties.providerId, kind: 'payment_verified_provider' },
            ]
          : [];
      }
      case 'SettlementIssued':
      case 'SettlementPaid': {
        const beneficiaryId = uuidOrNull(event.payload.beneficiaryId);
        if (!beneficiaryId) return [];
        return [
          {
            userId: beneficiaryId,
            kind: event.type === 'SettlementIssued' ? 'settlement_issued' : 'settlement_paid',
          },
        ];
      }
      case 'IncidentOpened':
        return (await this.directory.activeOperatorIds()).map((userId) => ({
          userId,
          kind: 'incident_opened' as const,
        }));
      default:
        return [];
    }
  }

  private async attempt(
    userId: string,
    inboxId: string,
    channel: DeliveryChannel,
  ): Promise<
    | { readonly ok: true }
    | { readonly ok: false; readonly code: string; readonly retryable: boolean }
  > {
    const sender = this.channels.get(channel);
    if (!sender?.enabled) return { ok: false, code: 'channel_disabled', retryable: false };
    const entry = await this.repository.findInboxEntry(inboxId);
    if (!entry) return { ok: false, code: 'notification_missing', retryable: false };
    // The contact is resolved again at send time: a user may have been suspended or unlinked.
    const [contact] = await this.directory.contacts([userId]);
    if (!contact || !sender.canReach(contact))
      return { ok: false, code: 'recipient_unreachable', retryable: false };
    try {
      return await sender.send(contact, { title: entry.title, body: entry.body });
    } catch {
      return { ok: false, code: 'channel_error', retryable: true };
    }
  }

  private reachableChannels(contact: RecipientContact): ReadonlySet<DeliveryChannel> {
    return new Set(
      [...this.channels.values()]
        .filter((channel) => channel.canReach(contact))
        .map((channel) => channel.channel),
    );
  }

  private enabledChannels(): ReadonlySet<DeliveryChannel> {
    return new Set(
      [...this.channels.values()].filter(({ enabled }) => enabled).map(({ channel }) => channel),
    );
  }

  private async recordChange(entry: InboxEntry): Promise<void> {
    await this.changes.record({
      entityId: entry.id,
      ownerUserId: entry.userId,
      occurredAt: entry.readAt ?? entry.createdAt,
      payload: {
        id: entry.id,
        kind: entry.kind,
        title: entry.title,
        body: entry.body,
        createdAt: entry.createdAt.toISOString(),
        readAt: entry.readAt?.toISOString() ?? null,
      },
    });
  }

  private encodeCursor(entry: InboxEntry): string {
    return Buffer.from(`${entry.createdAt.toISOString()}|${entry.id}`).toString('base64url');
  }

  private decodeCursor(cursor: string): { readonly createdAt: Date; readonly id: string } {
    const invalid = () => new DomainError('Cursor inválido.', 'invalid_cursor');
    if (cursor.length > MAX_CURSOR_LENGTH) throw invalid();
    const [createdAt, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    const date = new Date(createdAt ?? '');
    if (!id || !UUID.test(id) || Number.isNaN(date.getTime())) throw invalid();
    return { createdAt: date, id };
  }
}
