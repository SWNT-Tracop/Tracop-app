import { Global, Module } from '@nestjs/common';
import {
  IDENTITY_NOTIFICATION_DIRECTORY,
  IdentityModule,
  type IdentityNotificationDirectory,
} from '../modules/identity/index.js';
import { MESSAGING_PORT, MessagingModule, type MessagingPort } from '../modules/messaging/index.js';
import {
  MESSAGING_NOTIFICATION_CHANNEL,
  NOTIFICATION_CHANGE_RECORDER,
  RECIPIENT_DIRECTORY_PORT,
  type ChannelSendResult,
  type NotificationChangeRecorder,
  type NotificationChannelPort,
  type RecipientContact,
  type RecipientDirectoryPort,
} from '../modules/notifications/index.js';
import { OrderingModule, OrderingService } from '../modules/ordering/index.js';
import { SYNC_REPOSITORY, SyncModule, type SyncRepositoryPort } from '../modules/sync/index.js';

/** Recipients come from ordering (order parties) and identity (locale, linked channel, staff). */
export class NotificationRecipientDirectory implements RecipientDirectoryPort {
  constructor(
    private readonly ordering: OrderingService,
    private readonly identity: IdentityNotificationDirectory,
  ) {}

  async orderParties(orderId: string) {
    const aggregate = await this.ordering.getForPayment(orderId);
    return aggregate
      ? { buyerId: aggregate.order.buyerId, providerId: aggregate.order.providerId }
      : null;
  }

  activeOperatorIds(): Promise<readonly string[]> {
    return this.identity.listActiveStaffIds('operator', 50);
  }

  async contacts(userIds: readonly string[]): Promise<readonly RecipientContact[]> {
    return (await this.identity.findNotificationContacts(userIds)).map((contact) => ({
      userId: contact.userId,
      locale: contact.locale,
      messaging:
        contact.channel &&
        (contact.channel.channel === 'telegram' || contact.channel.channel === 'whatsapp')
          ? { channel: contact.channel.channel, channelUserId: contact.channel.channelUserId }
          : null,
    }));
  }
}

/** Sends notices through MessagingPort (Telegram today, WhatsApp later). */
export class MessagingNotificationChannel implements NotificationChannelPort {
  readonly channel = 'messaging' as const;
  readonly enabled = true;

  constructor(private readonly messaging: MessagingPort) {}

  canReach(contact: RecipientContact): boolean {
    return contact.messaging !== null;
  }

  async send(
    contact: RecipientContact,
    message: { readonly title: string; readonly body: string },
  ): Promise<ChannelSendResult> {
    if (!contact.messaging) return { ok: false, code: 'recipient_unreachable', retryable: false };
    const result = await this.messaging.sendText(
      contact.messaging,
      `${message.title}\n${message.body}`,
    );
    if (result.ok) return { ok: true };
    switch (result.error.kind) {
      case 'blocked_by_user':
      case 'invalid_recipient':
        return { ok: false, code: result.error.kind, retryable: false };
      case 'rate_limited':
        return { ok: false, code: 'rate_limited', retryable: true };
      default:
        return { ok: false, code: 'unavailable', retryable: result.error.retryable };
    }
  }
}

export class NotificationChangeRecorderAdapter implements NotificationChangeRecorder {
  constructor(private readonly sync: SyncRepositoryPort) {}

  async record(change: {
    readonly entityId: string;
    readonly payload: Record<string, unknown>;
    readonly ownerUserId: string;
    readonly occurredAt: Date;
  }): Promise<void> {
    await this.sync.appendChange({ entity: 'notification', op: 'upsert', ...change });
  }
}

@Global()
@Module({
  imports: [IdentityModule, MessagingModule, OrderingModule, SyncModule],
  providers: [
    {
      provide: RECIPIENT_DIRECTORY_PORT,
      inject: [OrderingService, IDENTITY_NOTIFICATION_DIRECTORY],
      useFactory: (ordering: OrderingService, identity: IdentityNotificationDirectory) =>
        new NotificationRecipientDirectory(ordering, identity),
    },
    {
      provide: MESSAGING_NOTIFICATION_CHANNEL,
      inject: [MESSAGING_PORT],
      useFactory: (messaging: MessagingPort) => new MessagingNotificationChannel(messaging),
    },
    {
      provide: NOTIFICATION_CHANGE_RECORDER,
      inject: [SYNC_REPOSITORY],
      useFactory: (sync: SyncRepositoryPort) => new NotificationChangeRecorderAdapter(sync),
    },
  ],
  exports: [RECIPIENT_DIRECTORY_PORT, MESSAGING_NOTIFICATION_CHANNEL, NOTIFICATION_CHANGE_RECORDER],
})
export class NotificationsBridgeModule {}
