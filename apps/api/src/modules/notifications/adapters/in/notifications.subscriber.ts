import type {
  OutboxEventRecord,
  OutboxSubscriberPort,
} from '../../../../shared/ports/outbox-subscriber.js';
import {
  NOTIFIED_EVENT_TYPES,
  type NotificationsService,
} from '../../application/notifications-service.js';

/** Turns domain events into inbox entries and delivery plans; idempotent per (event, user). */
export class NotificationsSubscriber implements OutboxSubscriberPort {
  readonly consumer = 'notifications.dispatch';
  readonly eventTypes = NOTIFIED_EVENT_TYPES;

  constructor(private readonly notifications: Pick<NotificationsService, 'handleEvent'>) {}

  async handle(event: OutboxEventRecord): Promise<void> {
    await this.notifications.handleEvent(event);
  }
}
