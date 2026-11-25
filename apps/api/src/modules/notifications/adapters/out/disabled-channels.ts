import type { DeliveryChannel } from '../../domain/notification.js';
import type {
  ChannelSendResult,
  NotificationChannelPort,
} from '../../ports/notifications-ports.js';

/**
 * A channel without a provider yet (push: FCM; SMS: provider pending, AGENTS §23.7). Its planned
 * deliveries are recorded as skipped, so the next channel is tried.
 */
export class DisabledNotificationChannel implements NotificationChannelPort {
  readonly enabled = false;

  constructor(readonly channel: Exclude<DeliveryChannel, 'messaging'>) {}

  canReach(): boolean {
    return false;
  }

  async send(): Promise<ChannelSendResult> {
    return { ok: false, code: 'channel_disabled', retryable: false };
  }
}
