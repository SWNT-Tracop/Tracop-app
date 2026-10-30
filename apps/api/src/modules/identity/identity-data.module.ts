import { Module } from '@nestjs/common';
import { HmacPasswordlessHasher, HmacTokenService } from './adapters/out/crypto-services.js';
import {
  DrizzleConsentRepository,
  DrizzleDeviceRepository,
  DrizzleOtpRepository,
  DrizzleSessionRepository,
  DrizzleUserRepository,
  PostgresRateLimiter,
} from './adapters/out/drizzle-repositories.js';
import {
  CONSENT_REPOSITORY,
  DEVICE_REPOSITORY,
  IDENTITY_HASHER,
  OTP_REPOSITORY,
  PASSWORDLESS_HASHER,
  RATE_LIMITER,
  SESSION_REPOSITORY,
  TOKEN_SERVICE,
  USER_REPOSITORY,
} from './ports/tokens.js';

@Module({
  providers: [
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
  ],
  exports: [
    USER_REPOSITORY,
    OTP_REPOSITORY,
    SESSION_REPOSITORY,
    DEVICE_REPOSITORY,
    CONSENT_REPOSITORY,
    PASSWORDLESS_HASHER,
    IDENTITY_HASHER,
    TOKEN_SERVICE,
    RATE_LIMITER,
  ],
})
export class IdentityDataModule {}
