import { Module } from '@nestjs/common';
import { IdentityAuthModule } from './identity-auth.module.js';
import { IdentityChannelModule } from './identity-channel.module.js';

@Module({
  imports: [IdentityAuthModule, IdentityChannelModule],
  exports: [IdentityAuthModule, IdentityChannelModule],
})
export class IdentityModule {}
