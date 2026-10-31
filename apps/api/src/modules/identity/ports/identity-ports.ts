import type { Result } from '../../../shared/kernel/result.js';
import type { DomainError } from '../../../shared/kernel/domain-error.js';
import type { ChannelLinkProps, IdentityChannel } from '../domain/channel-link.js';
import type { OtpPurpose, OtpProps } from '../domain/otp.js';
import type { SessionProps } from '../domain/session.js';
import type { PhoneNumber } from '../domain/phone-number.js';
import type { UserProps } from '../domain/user.js';

export interface UserRepository {
  findByPhone(phone: PhoneNumber): Promise<UserProps | null>;
  findById(id: string): Promise<UserProps | null>;
  create(user: UserProps): Promise<void>;
  update(user: UserProps): Promise<void>;
}

export interface OtpRepository {
  create(otp: OtpProps): Promise<void>;
  findLatestForUpdate(userId: string, purpose: OtpPurpose): Promise<OtpProps | null>;
  update(otp: OtpProps): Promise<void>;
}

export interface SessionRepository {
  create(session: SessionProps): Promise<void>;
  findByRefreshHashForUpdate(refreshHash: string): Promise<SessionProps | null>;
  findById(id: string): Promise<SessionProps | null>;
  findFamilyForDevice(userId: string, deviceId: string): Promise<string | null>;
  update(session: SessionProps): Promise<void>;
  revokeFamily(familyId: string, now: Date, reason: string): Promise<readonly SessionProps[]>;
  revokeSession(id: string, now: Date, reason: string): Promise<SessionProps | null>;
}

export interface DeviceRepository {
  upsert(input: {
    id: string;
    userId: string;
    platform: 'ios' | 'android' | 'web' | 'other';
    lastSeenAt: Date;
  }): Promise<void>;
  belongsToUser(deviceId: string, userId: string): Promise<boolean>;
}

export interface ConsentRepository {
  create(input: {
    id: string;
    userId: string;
    policyType: string;
    version: string;
    acceptedAt: Date;
    channel: string;
  }): Promise<void>;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfter: number;
}

export interface RateLimiterPort {
  consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult>;
}

export interface OtpSenderPort {
  send(phone: PhoneNumber, code: string): Promise<void>;
}

export interface ChannelLinkRepository {
  findByChannelUser(
    channel: IdentityChannel,
    channelUserId: string,
  ): Promise<ChannelLinkProps | null>;
  findVerifiedByPhone(phone: PhoneNumber): Promise<ChannelLinkProps | null>;
  create(link: ChannelLinkProps): Promise<void>;
}

export interface IdentityChannelLink {
  userId: string;
  channel: IdentityChannel;
  channelUserId: string;
}

export interface LinkChannelResult {
  status: 'linked' | 'already_linked';
  userId: string;
}

export interface IdentityChannelApplication {
  findActiveLinkByChannelUser(
    channel: IdentityChannel,
    channelUserId: string,
  ): Promise<IdentityChannelLink | null>;
  findActiveChannelLinkByPhone(phone: string): Promise<IdentityChannelLink | null>;
  linkChannel(command: {
    channel: IdentityChannel;
    channelUserId: string;
    phone: string;
  }): Promise<Result<LinkChannelResult, DomainError>>;
}

export interface AccessTokenClaims {
  sub: string;
  role: UserProps['role'];
  sid: string;
  did: string;
  jti: string;
  exp: number;
}

export interface TokenServicePort {
  issueAccessToken(
    user: UserProps,
    sessionId: string,
    deviceId: string,
    now: Date,
  ): Promise<string>;
  verifyAccessToken(token: string, now: Date): Promise<AccessTokenClaims | null>;
  createRefreshToken(): string;
}

export interface PasswordlessHasherPort {
  hashOtp(phone: PhoneNumber, purpose: OtpPurpose, code: string): string;
  verifyOtp(phone: PhoneNumber, purpose: OtpPurpose, code: string, expectedHash: string): boolean;
  hashRefreshToken(token: string): string;
  hashRateLimitKey(key: string): string;
}

export interface IdentityUnitOfWork {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

export interface IdentitySettings {
  NODE_ENV: 'development' | 'test' | 'production';
  PRIVACY_POLICY_VERSION: string;
  TELEGRAM_BOT_USERNAME: string;
  allowedCountryCodes: readonly string[];
  supportedLocales: readonly string[];
  OTP_LENGTH: number;
  OTP_TTL_SECONDS: number;
  OTP_MAX_ATTEMPTS: number;
  OTP_PHONE_LIMIT: number;
  OTP_PHONE_WINDOW_SECONDS: number;
  OTP_PHONE_COOLDOWN_LIMIT: number;
  OTP_PHONE_COOLDOWN_SECONDS: number;
  OTP_IP_REQUEST_LIMIT: number;
  OTP_IP_VERIFY_LIMIT: number;
  OTP_IP_WINDOW_SECONDS: number;
  ACCESS_TOKEN_TTL_SECONDS: number;
  REFRESH_TOKEN_TTL_SECONDS: number;
}
