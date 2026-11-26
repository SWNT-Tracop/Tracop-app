export { IdentityModule } from './identity.module.js';
export { IdentityChannelModule } from './identity-channel.module.js';
export { IdentityAssistantModule } from './identity-assistant.module.js';
export {
  DemoCaptureOtpSender,
  DevelopmentOtpSender,
  InMemoryOtpSender,
} from './adapters/out/otp-senders.js';
export {
  CHANNEL_LINK_REPOSITORY,
  IDENTITY_ACCESS_TOKEN_VERIFIER,
  PROVIDER_PROFILE_SERVICE,
  IDENTITY_APPLICATION,
  IDENTITY_CHANNEL_APPLICATION,
  IDENTITY_CHANNEL_ONBOARDING,
  IDENTITY_NOTIFICATION_DIRECTORY,
  OTP_SENDER,
  IDENTITY_MAINTENANCE,
  IDENTITY_ASSISTANT,
} from './ports/tokens.js';
export { ProviderProfileService } from './application/provider-profile-service.js';
export type {
  ChannelOnboardingResult,
  ChannelOnboardingService,
} from './application/channel-onboarding-service.js';
export type { ProviderPublicSummary } from './domain/provider-profile.js';
export type { IdentityChannel } from './domain/channel-link.js';
export type { PhoneNumber } from './domain/phone-number.js';
export type {
  ChannelLinkRepository,
  IdentityChannelApplication,
  IdentityChannelLink,
  IdentityNotificationDirectory,
  NotificationContact,
  LinkChannelResult,
  OtpSenderPort,
  IdentityMaintenanceApi,
} from './ports/identity-ports.js';
export type {
  AiConsentChannel,
  AssistantUserView,
  IdentityAssistantApi,
} from './ports/assistant-ports.js';
