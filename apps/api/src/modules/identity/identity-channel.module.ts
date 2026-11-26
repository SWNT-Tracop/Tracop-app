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
  SESSION_REPOSITORY,
  USER_REPOSITORY,
} from './ports/tokens.js';
import type { AppEnvironment } from '../../shared/infra/env.js';

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
      inject: [
        USER_REPOSITORY,
        CHANNEL_LINK_REPOSITORY,
        AUDIT_WRITER,
        UNIT_OF_WORK,
        SESSION_REPOSITORY,
        OUTBOX_WRITER,
        APP_CLOCK,
        APP_ENVIRONMENT,
      ],
      useFactory: (
        users: ConstructorParameters<typeof IdentityStaffService>[0],
        links: ConstructorParameters<typeof IdentityStaffService>[1],
        audit: ConstructorParameters<typeof IdentityStaffService>[2],
        uow: ConstructorParameters<typeof IdentityStaffService>[3],
        sessions: ConstructorParameters<typeof IdentityStaffService>[4],
        outbox: ConstructorParameters<typeof IdentityStaffService>[5],
        clock: ConstructorParameters<typeof IdentityStaffService>[6],
        environment: AppEnvironment,
      ) =>
        new IdentityStaffService(users, links, audit, uow, sessions, outbox, clock, {
          allowedCountryCodes: environment.allowedCountryCodes,
        }),
    },
  ],
  exports: [IDENTITY_CHANNEL_APPLICATION, IDENTITY_NOTIFICATION_DIRECTORY],
})
export class IdentityChannelModule {}
