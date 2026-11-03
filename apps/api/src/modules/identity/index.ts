export { IdentityModule } from './identity.module.js';
export { IdentityChannelModule } from './identity-channel.module.js';
export { DevelopmentOtpSender, InMemoryOtpSender } from './adapters/out/otp-senders.js';
export {
  CHANNEL_LINK_REPOSITORY,
  IDENTITY_ACCESS_TOKEN_VERIFIER,
  PROVIDER_PROFILE_SERVICE,
  IDENTITY_APPLICATION,
  IDENTITY_CHANNEL_APPLICATION,
  OTP_SENDER,
} from './ports/tokens.js';
export { ProviderProfileService } from './application/provider-profile-service.js';
export type { ProviderPublicSummary } from './domain/provider-profile.js';
export type { IdentityChannel } from './domain/channel-link.js';
export type { PhoneNumber } from './domain/phone-number.js';
export type {
  ChannelLinkRepository,
  IdentityChannelApplication,
  IdentityChannelLink,
  LinkChannelResult,
  OtpSenderPort,
} from './ports/identity-ports.js';
