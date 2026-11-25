import { Module } from '@nestjs/common';
import {
  APP_CLOCK,
  APP_ENVIRONMENT,
  OUTBOX_WRITER,
  UNIT_OF_WORK,
} from '../../shared/infra/tokens.js';
import { AUDIT_WRITER } from '../../shared/ports/audit-writer.js';
import { IdentityStaffController } from './adapters/in/identity-staff.controller.js';
import { IdentityStaffService } from './application/identity-staff-service.js';
import { IdentityChannelService } from './application/identity-channel-service.js';
import { DrizzleChannelLinkRepository } from './adapters/out/drizzle-repositories.js';
import { IdentityDataModule } from './identity-data.module.js';
import {
  CHANNEL_LINK_REPOSITORY,
  IDENTITY_CHANNEL_APPLICATION,
  IDENTITY_STAFF,
  IDENTITY_NOTIFICATION_DIRECTORY,
  USER_REPOSITORY,
} from './ports/tokens.js';

@Module({
  imports: [IdentityDataModule],
  controllers: [IdentityStaffController],
  providers: [
    DrizzleChannelLinkRepository,
    { provide: CHANNEL_LINK_REPOSITORY, useExisting: DrizzleChannelLinkRepository },
    {
      provide: IDENTITY_CHANNEL_APPLICATION,
      inject: [APP_ENVIRONMENT, USER_REPOSITORY, CHANNEL_LINK_REPOSITORY, APP_CLOCK, OUTBOX_WRITER],
      useFactory: (...dependencies: ConstructorParameters<typeof IdentityChannelService>) =>
        new IdentityChannelService(...dependencies),
    },
    { provide: IDENTITY_NOTIFICATION_DIRECTORY, useExisting: IDENTITY_CHANNEL_APPLICATION },
    {
      provide: IDENTITY_STAFF,
      inject: [USER_REPOSITORY, CHANNEL_LINK_REPOSITORY, AUDIT_WRITER, UNIT_OF_WORK],
      useFactory: (...dependencies: ConstructorParameters<typeof IdentityStaffService>) =>
        new IdentityStaffService(...dependencies),
    },
  ],
  exports: [IDENTITY_CHANNEL_APPLICATION, IDENTITY_NOTIFICATION_DIRECTORY],
})
export class IdentityChannelModule {}
