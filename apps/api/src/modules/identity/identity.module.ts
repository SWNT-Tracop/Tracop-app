import { Module } from '@nestjs/common';
import {
  APP_CLOCK,
  APP_ENVIRONMENT,
  OUTBOX_WRITER,
  UNIT_OF_WORK,
} from '../../shared/infra/tokens.js';
import { IdentityApplicationService } from './application/identity-application-service.js';
import { IdentityController } from './adapters/in/identity.controller.js';
import { IdentityAuthGuard } from './adapters/in/identity-auth.guard.js';
import {
  DrizzleConsentRepository,
  DrizzleDeviceRepository,
  DrizzleOtpRepository,
  DrizzleSessionRepository,
  DrizzleUserRepository,
  PostgresRateLimiter,
} from './adapters/out/drizzle-repositories.js';
import { HmacPasswordlessHasher, HmacTokenService } from './adapters/out/crypto-services.js';
import { DevelopmentOtpSender, InMemoryOtpSender } from './adapters/out/otp-senders.js';
import {
  CONSENT_REPOSITORY,
  DEVICE_REPOSITORY,
  IDENTITY_APPLICATION,
  IDENTITY_HASHER,
  OTP_REPOSITORY,
  OTP_SENDER,
  PASSWORDLESS_HASHER,
  RATE_LIMITER,
  SESSION_REPOSITORY,
  TOKEN_SERVICE,
  USER_REPOSITORY,
} from './ports/tokens.js';

const repositoryProviders = [
  DrizzleUserRepository,
  DrizzleOtpRepository,
  DrizzleSessionRepository,
  DrizzleDeviceRepository,
  DrizzleConsentRepository,
  { provide: USER_REPOSITORY, useExisting: DrizzleUserRepository },
  { provide: OTP_REPOSITORY, useExisting: DrizzleOtpRepository },
  { provide: SESSION_REPOSITORY, useExisting: DrizzleSessionRepository },
  { provide: DEVICE_REPOSITORY, useExisting: DrizzleDeviceRepository },
  { provide: CONSENT_REPOSITORY, useExisting: DrizzleConsentRepository },
  HmacPasswordlessHasher,
  { provide: PASSWORDLESS_HASHER, useExisting: HmacPasswordlessHasher },
  { provide: IDENTITY_HASHER, useExisting: HmacPasswordlessHasher },
  HmacTokenService,
  { provide: TOKEN_SERVICE, useExisting: HmacTokenService },
  PostgresRateLimiter,
  { provide: RATE_LIMITER, useExisting: PostgresRateLimiter },
  {
    provide: OTP_SENDER,
    inject: [APP_ENVIRONMENT],
    useFactory: (environment: { NODE_ENV: string; OTP_SENDER: string }) => {
      if (environment.NODE_ENV === 'test') return new InMemoryOtpSender();
      if (environment.NODE_ENV === 'development' && environment.OTP_SENDER === 'console') {
        return new DevelopmentOtpSender(environment as never);
      }
      throw new Error('No OtpSenderPort is configured for this environment.');
    },
  },
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
    ],
    useFactory: (...dependencies: ConstructorParameters<typeof IdentityApplicationService>) =>
      new IdentityApplicationService(...dependencies),
  },
  IdentityAuthGuard,
];

@Module({
  controllers: [IdentityController],
  providers: repositoryProviders,
  exports: [IDENTITY_APPLICATION, OTP_SENDER],
})
export class IdentityModule {}
