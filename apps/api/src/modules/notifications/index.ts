export { NotificationsModule } from './notifications.module.js';
export {
  NOTIFICATIONS_MAINTENANCE,
  NOTIFICATIONS_METRICS,
  NOTIFICATIONS_OUTBOX_SUBSCRIBER,
  NOTIFICATIONS_SERVICE,
  type NotificationsMaintenanceApi,
} from './application/notifications-tokens.js';
export type { NotificationsService } from './application/notifications-service.js';
export {
  MESSAGING_NOTIFICATION_CHANNEL,
  NOTIFICATION_CHANGE_RECORDER,
  RECIPIENT_DIRECTORY_PORT,
  type ChannelSendResult,
  type NotificationChangeRecorder,
  type NotificationChannelPort,
  type NotificationsMetricsQuery,
  type RecipientContact,
  type RecipientDirectoryPort,
} from './ports/notifications-ports.js';
