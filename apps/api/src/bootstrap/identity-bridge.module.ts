import { Global, Module } from '@nestjs/common';
import {
  IDENTITY_CHANNEL_APPLICATION,
  IdentityChannelModule,
  type IdentityChannelApplication,
} from '../modules/identity/index.js';
import { CHANNEL_IDENTITY_PORT } from '../modules/messaging/index.js';
import { IdentityChannelAdapter } from './identity-channel.adapter.js';

@Global()
@Module({
  imports: [IdentityChannelModule],
  providers: [
    {
      provide: CHANNEL_IDENTITY_PORT,
      inject: [IDENTITY_CHANNEL_APPLICATION],
      useFactory: (identity: IdentityChannelApplication) => new IdentityChannelAdapter(identity),
    },
  ],
  exports: [CHANNEL_IDENTITY_PORT],
})
export class IdentityBridgeModule {}
