export { IdentityModule } from './identity.module.js';
export { IdentityChannelModule } from './identity-channel.module.js';
export { DevelopmentOtpSender, InMemoryOtpSender } from './adapters/out/otp-senders.js';
export {
  CHANNEL_LINK_REPOSITORY,
  IDENTITY_APPLICATION,
  IDENTITY_CHANNEL_APPLICATION,
  OTP_SENDER,
} from './ports/tokens.js';
export type { IdentityChannel } from './domain/channel-link.js';
export type { PhoneNumber } from './domain/phone-number.js';
export type {
  ChannelLinkRepository,
  IdentityChannelApplication,
  IdentityChannelLink,
  LinkChannelResult,
  OtpSenderPort,
} from './ports/identity-ports.js';
