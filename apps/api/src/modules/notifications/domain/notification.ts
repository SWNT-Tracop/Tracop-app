import { DomainError } from '../../../shared/kernel/domain-error.js';

export const NOTIFICATION_KINDS = [
  'order_received',
  'payment_verified_buyer',
  'payment_verified_provider',
  'payment_rejected',
  'pickup_scheduled',
  'in_transit',
  'delivered',
  'settlement_issued',
  'settlement_paid',
  'incident_opened',
  'lot_alert',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** Critical notices ignore quiet hours and may fall back to SMS. */
const CRITICAL_KINDS: ReadonlySet<NotificationKind> = new Set([
  'payment_rejected',
  'incident_opened',
]);

export const isCritical = (kind: NotificationKind): boolean => CRITICAL_KINDS.has(kind);

export const DELIVERY_CHANNELS = ['messaging', 'push', 'sms'] as const;
export type DeliveryChannel = (typeof DELIVERY_CHANNELS)[number];
export const DEFAULT_CHANNEL_ORDER: readonly DeliveryChannel[] = ['messaging', 'push', 'sms'];

export type DeliveryStatus = 'pending' | 'sent' | 'failed' | 'skipped';

export interface QuietHours {
  /** Local time in America/Bogota, HH:MM. */
  readonly start: string;
  readonly end: string;
}

export interface NotificationPreferences {
  readonly channelOrder: readonly DeliveryChannel[];
  readonly quietHours: QuietHours | null;
}

export const DEFAULT_PREFERENCES: NotificationPreferences = {
  channelOrder: DEFAULT_CHANNEL_ORDER,
  quietHours: null,
};

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const BOGOTA_OFFSET_MINUTES = -5 * 60; // Colombia has no daylight saving time.

const minutesOf = (value: string): number => {
  const match = TIME.exec(value);
  if (!match) throw new DomainError('La hora debe tener el formato HH:MM.', 'invalid_quiet_hours');
  return Number(match[1]) * 60 + Number(match[2]);
};

export const validatePreferences = (input: NotificationPreferences): NotificationPreferences => {
  const order = input.channelOrder;
  if (
    order.length === 0 ||
    new Set(order).size !== order.length ||
    order.some((channel) => !DELIVERY_CHANNELS.includes(channel))
  )
    throw new DomainError('El orden de canales no es válido.', 'invalid_channel_order');
  if (input.quietHours) {
    if (minutesOf(input.quietHours.start) === minutesOf(input.quietHours.end))
      throw new DomainError('El horario sin molestias está vacío.', 'invalid_quiet_hours');
  }
  return {
    channelOrder: [...order],
    quietHours: input.quietHours ? { ...input.quietHours } : null,
  };
};

/**
 * When a non-critical notice may be sent: now, or the end of the quiet window that contains
 * now. Windows may cross midnight (22:00–06:00).
 */
export const nextAllowedSendAt = (now: Date, quietHours: QuietHours | null): Date => {
  if (!quietHours) return now;
  const start = minutesOf(quietHours.start);
  const end = minutesOf(quietHours.end);
  const localMs = now.getTime() + BOGOTA_OFFSET_MINUTES * 60_000;
  const local = new Date(localMs);
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  const inside = start < end ? minute >= start && minute < end : minute >= start || minute < end;
  if (!inside) return now;
  const dayStart = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  let endLocal = dayStart + end * 60_000;
  if (endLocal <= localMs) endLocal += 86_400_000;
  return new Date(endLocal - BOGOTA_OFFSET_MINUTES * 60_000);
};

export interface PlannedDelivery {
  readonly channel: DeliveryChannel;
  readonly status: 'pending' | 'skipped';
  readonly nextAttemptAt: Date | null;
}

/**
 * Picks the first channel in the user's order that can reach them. Channels without a provider
 * (push and SMS today) are recorded as skipped and the next one is tried. SMS is only for
 * critical notices. The inbox is written separately and always.
 */
export const planDeliveries = (input: {
  readonly kind: NotificationKind;
  readonly preferences: NotificationPreferences;
  readonly reachable: ReadonlySet<DeliveryChannel>;
  readonly enabled: ReadonlySet<DeliveryChannel>;
  readonly now: Date;
}): readonly PlannedDelivery[] => {
  const critical = isCritical(input.kind);
  const sendAt = critical ? input.now : nextAllowedSendAt(input.now, input.preferences.quietHours);
  const planned: PlannedDelivery[] = [];
  for (const channel of input.preferences.channelOrder) {
    if (channel === 'sms' && !critical) continue;
    if (!input.enabled.has(channel)) {
      planned.push({ channel, status: 'skipped', nextAttemptAt: null });
      continue;
    }
    if (!input.reachable.has(channel)) continue;
    planned.push({ channel, status: 'pending', nextAttemptAt: sendAt });
    break;
  }
  return planned;
};

/** Exponential backoff after `attempts` failed tries, capped. */
export const retryDelaySeconds = (
  attempts: number,
  baseSeconds: number,
  maxSeconds: number,
): number => Math.min(maxSeconds, baseSeconds * 2 ** Math.max(0, attempts - 1));
