export { MessagingModule } from './messaging.module.js';
export { InMemoryMessagingAdapter } from './adapters/out/in-memory-messaging.adapter.js';
export { TelegramAdapter } from './adapters/out/telegram.adapter.js';
export { messagingMessages } from './i18n.js';
export {
  CHANNEL_IDENTITY_PORT,
  MESSAGING_APPLICATION,
  MESSAGING_PORT,
  PROCESSED_UPDATES_REPOSITORY,
} from './ports/tokens.js';
export type {
  ChannelIdentityPort,
  LinkChannelOutcome,
  MessagingApplication,
  MessagingPort,
  MessagingUnitOfWork,
  ProcessedUpdatesRepository,
  UpdateProcessingResult,
} from './ports/messaging-ports.js';
export type {
  ChannelUserRef,
  InboundContact,
  InboundMessage,
  MessagingError,
  OutboundButton,
  OutboundMessage,
} from './domain/messaging.js';
