import { Global, Module } from '@nestjs/common';
import {
  IDENTITY_CHANNEL_APPLICATION,
  IDENTITY_CHANNEL_ONBOARDING,
  IdentityModule,
  type ChannelOnboardingService,
  type IdentityChannelApplication,
} from '../modules/identity/index.js';
import { CHANNEL_IDENTITY_PORT } from '../modules/messaging/index.js';
import { IdentityChannelAdapter } from './identity-channel.adapter.js';

@Global()
@Module({
  imports: [IdentityModule],
  providers: [
    {
      provide: CHANNEL_IDENTITY_PORT,
      inject: [IDENTITY_CHANNEL_APPLICATION, IDENTITY_CHANNEL_ONBOARDING],
      useFactory: (identity: IdentityChannelApplication, onboarding: ChannelOnboardingService) =>
        new IdentityChannelAdapter(identity, onboarding),
    },
  ],
  exports: [CHANNEL_IDENTITY_PORT],
})
export class IdentityBridgeModule {}
