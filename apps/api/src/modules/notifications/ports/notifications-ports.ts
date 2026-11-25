import type {
  DeliveryChannel,
  NotificationKind,
  NotificationPreferences,
  PlannedDelivery,
} from '../domain/notification.js';

/** How to reach a user, from identity; only what delivery needs. */
export interface RecipientContact {
  readonly userId: string;
  readonly locale: string;
  /** A verified messaging channel (Telegram today), if the user linked one. */
  readonly messaging: {
    readonly channel: 'telegram' | 'whatsapp';
    readonly channelUserId: string;
  } | null;
}

/** Who takes part in an order and who the staff are, from ordering and identity. */
export interface RecipientDirectoryPort {
  orderParties(
    orderId: string,
  ): Promise<{ readonly buyerId: string; readonly providerId: string } | null>;
  activeOperatorIds(): Promise<readonly string[]>;
  contacts(userIds: readonly string[]): Promise<readonly RecipientContact[]>;
}

export type ChannelSendResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly retryable: boolean };

/** One delivery channel (NotificationPort in AGENTS §8). */
export interface NotificationChannelPort {
  readonly channel: DeliveryChannel;
  /** False when no provider is configured; its deliveries are recorded as skipped. */
  readonly enabled: boolean;
  canReach(contact: RecipientContact): boolean;
  send(
    contact: RecipientContact,
    message: { readonly title: string; readonly body: string },
  ): Promise<ChannelSendResult>;
}

export interface InboxEntry {
  readonly id: string;
  readonly userId: string;
  readonly eventId: string;
  readonly kind: NotificationKind;
  readonly title: string;
  readonly body: string;
  readonly templateVersion: string;
  readonly createdAt: Date;
  readonly readAt: Date | null;
}

export interface DueDelivery {
  readonly id: string;
  readonly inboxId: string;
  readonly userId: string;
  readonly channel: DeliveryChannel;
  readonly attempts: number;
  readonly leaseToken: string;
}

export interface NotificationRepository {
  /** Inserts the inbox entry and its deliveries unless (event, user) exists; returns whether. */
  insertNotification(entry: InboxEntry, deliveries: readonly PlannedDelivery[]): Promise<boolean>;
  findPreferences(
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, NotificationPreferences>>;
  savePreferences(userId: string, preferences: NotificationPreferences, now: Date): Promise<void>;
  listInbox(
    userId: string,
    cursor: { readonly createdAt: Date; readonly id: string } | null,
    limit: number,
  ): Promise<readonly InboxEntry[]>;
  findInboxEntry(id: string): Promise<InboxEntry | null>;
  /** Marks it read once; returns the entry as it is now, or null if it is not the user's. */
  markRead(id: string, userId: string, now: Date): Promise<InboxEntry | null>;
  /** Claims due pending deliveries with a lease (SKIP LOCKED). */
  claimDue(now: Date, leaseUntil: Date, limit: number): Promise<readonly DueDelivery[]>;
  completeDelivery(input: {
    readonly id: string;
    readonly leaseToken: string;
    readonly status: 'sent' | 'failed' | 'pending';
    readonly attempts: number;
    readonly nextAttemptAt: Date | null;
    readonly lastError: string | null;
    readonly now: Date;
  }): Promise<boolean>;
}

/** Offline inbox: notification changes go to sync.change_log for their owner. */
export interface NotificationChangeRecorder {
  record(change: {
    readonly entityId: string;
    readonly payload: Record<string, unknown>;
    readonly ownerUserId: string;
    readonly occurredAt: Date;
  }): Promise<void>;
}

/** Deliveries per status, for the backoffice. */
export interface NotificationsMetricsQuery {
  deliveriesByStatus(): Promise<
    Readonly<Record<'pending' | 'sent' | 'failed' | 'skipped', number>>
  >;
}

export interface NotificationsUnitOfWork {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

export interface NotificationsClock {
  now(): Date;
}

export interface NotificationsSettings {
  readonly maxAttempts: number;
  readonly retryBaseSeconds: number;
  readonly retryMaxSeconds: number;
  readonly leaseSeconds: number;
}

export const RECIPIENT_DIRECTORY_PORT = Symbol('RECIPIENT_DIRECTORY_PORT');
/** The messaging channel (Telegram), adapted from the messaging module in bootstrap. */
export const MESSAGING_NOTIFICATION_CHANNEL = Symbol('MESSAGING_NOTIFICATION_CHANNEL');
export const NOTIFICATION_CHANGE_RECORDER = Symbol('NOTIFICATION_CHANGE_RECORDER');
export const NOTIFICATIONS_SETTINGS = Symbol('NOTIFICATIONS_SETTINGS');
