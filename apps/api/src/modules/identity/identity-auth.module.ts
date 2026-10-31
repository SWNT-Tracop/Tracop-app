import { Module } from '@nestjs/common';
import {
  APP_CLOCK,
  APP_ENVIRONMENT,
  BACKGROUND_DISPATCHER,
  OUTBOX_WRITER,
  UNIT_OF_WORK,
} from '../../shared/infra/tokens.js';
import { IdentityApplicationService } from './application/identity-application-service.js';
import { IdentityController } from './adapters/in/identity.controller.js';
import { IdentityAuthGuard } from './adapters/in/identity-auth.guard.js';
import { IdentityDataModule } from './identity-data.module.js';
import {
  CONSENT_REPOSITORY,
  DEVICE_REPOSITORY,
  IDENTITY_APPLICATION,
  OTP_REPOSITORY,
  OTP_SENDER,
  PASSWORDLESS_HASHER,
  RATE_LIMITER,
  SESSION_REPOSITORY,
  TOKEN_SERVICE,
  USER_REPOSITORY,
} from './ports/tokens.js';

@Module({
  imports: [IdentityDataModule],
  controllers: [IdentityController],
  providers: [
    {
      provide: IDENTITY_APPLICATION,
      inject: [
        APP_ENVIRONMENT,
        USER_REPOSITORY,
        OTP_REPOSITORY,
        SESSION_REPOSITORY,
        DEVICE_REPOSITORY,
        CONSENT_REPOSITORY,
        RATE_LIMITER,
        OTP_SENDER,
        TOKEN_SERVICE,
        PASSWORDLESS_HASHER,
        APP_CLOCK,
        UNIT_OF_WORK,
        OUTBOX_WRITER,
        BACKGROUND_DISPATCHER,
      ],
      useFactory: (...dependencies: ConstructorParameters<typeof IdentityApplicationService>) =>
        new IdentityApplicationService(...dependencies),
    },
    IdentityAuthGuard,
  ],
  exports: [IDENTITY_APPLICATION],
})
export class IdentityAuthModule {}
