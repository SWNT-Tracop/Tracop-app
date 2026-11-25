import { Module } from '@nestjs/common';
import { APP_CLOCK, UNIT_OF_WORK } from '../../shared/infra/tokens.js';
import { DrizzleChannelLinkRepository } from './adapters/out/drizzle-repositories.js';
import { DrizzleIdentityAssistantRepository } from './adapters/out/drizzle-assistant-repository.js';
import { IdentityAssistantService } from './application/identity-assistant-service.js';
import { IdentityDataModule } from './identity-data.module.js';
import { IDENTITY_ASSISTANT, USER_REPOSITORY } from './ports/tokens.js';

/** The AI assistant's view of identity: chat user, provider location and AI consent. */
@Module({
  imports: [IdentityDataModule],
  providers: [
    DrizzleChannelLinkRepository,
    DrizzleIdentityAssistantRepository,
    {
      provide: IDENTITY_ASSISTANT,
      inject: [
        USER_REPOSITORY,
        DrizzleChannelLinkRepository,
        DrizzleIdentityAssistantRepository,
        UNIT_OF_WORK,
        APP_CLOCK,
      ],
      useFactory: (...dependencies: ConstructorParameters<typeof IdentityAssistantService>) =>
        new IdentityAssistantService(...dependencies),
    },
  ],
  exports: [IDENTITY_ASSISTANT],
})
export class IdentityAssistantModule {}
