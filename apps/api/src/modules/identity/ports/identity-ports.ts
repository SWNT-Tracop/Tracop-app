import type { Result } from '../../../shared/kernel/result.js';
import type { DomainError } from '../../../shared/kernel/domain-error.js';
import type { ChannelLinkProps, IdentityChannel } from '../domain/channel-link.js';
import type { OtpPurpose, OtpProps } from '../domain/otp.js';
import type { SessionProps } from '../domain/session.js';
import type { PhoneNumber } from '../domain/phone-number.js';
import type { UserProps } from '../domain/user.js';
import type { ProviderProfileProps, ProviderPublicSummary } from '../domain/provider-profile.js';

export interface UserRepository {
  findByPhone(phone: PhoneNumber): Promise<UserProps | null>;
  findById(id: string): Promise<UserProps | null>;
  /** Ids of active users with the role, oldest first. */
  listActiveIdsByRole(role: UserProps['role'], limit: number): Promise<readonly string[]>;
  create(user: UserProps): Promise<void>;
  update(user: UserProps): Promise<void>;
}

export interface ProviderProfileRepository {
  upsert(profile: ProviderProfileProps): Promise<void>;
  findPublicSummaries(ids: readonly string[]): Promise<ReadonlyMap<string, ProviderPublicSummary>>;
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
  /**
   * The live, never rotated session of a family created at or after `since`, locked; null when
   * any session created since then was already rotated (the chain moved on: no grace).
   */
  findActiveSuccessor(
    familyId: string,
    since: Date,
    rotatedId: string,
  ): Promise<SessionProps | null>;
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
  /** The user's most recently verified channel link, if any. */
  findVerifiedByUser(userId: string): Promise<ChannelLinkProps | null>;
  create(link: ChannelLinkProps): Promise<void>;
  /** Removes a user's link on a channel; returns it, or null if there was none. */
  deleteForUser(userId: string, channel: string): Promise<ChannelLinkProps | null>;
}

/** How to reach a user with a notification; no phone or name, only what delivery needs. */
export interface NotificationContact {
  readonly userId: string;
  readonly locale: string;
  readonly channel: IdentityChannelLink | null;
}

/** Identity data the notifications module may read. */
export interface IdentityNotificationDirectory {
  /** Active users only; suspended or unknown users are not notified. */
  findNotificationContacts(userIds: readonly string[]): Promise<readonly NotificationContact[]>;
  /** Active staff of a role (operator, finance, admin). */
  listActiveStaffIds(
    role: 'operator' | 'finance' | 'admin',
    limit: number,
  ): Promise<readonly string[]>;
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
  REFRESH_GRACE_SECONDS: number;
}

/** Deletes data that is no longer needed, in bounded batches; each call returns rows deleted. */
export interface IdentityRetentionRepository {
  /** OTP codes whose validity ended before the cutoff (consumed codes included). */
  deleteOtpCodesExpiredBefore(cutoff: Date, limit: number): Promise<number>;
  /** Sessions that expired or were revoked before the cutoff. Live sessions are never touched. */
  deleteSessionsEndedBefore(cutoff: Date, limit: number): Promise<number>;
  /** Rate-limit windows that started before the cutoff. */
  deleteRateLimitWindowsBefore(cutoff: Date, limit: number): Promise<number>;
  /**
   * Registrations still pending verification created before the cutoff become `expired`; the
   * phone is replaced by `pseudonym(id, phone)` and the name cleared, freeing the number.
   */
  expireUnverifiedBefore(
    cutoff: Date,
    limit: number,
    pseudonym: (userId: string, phone: string) => string,
    now: Date,
  ): Promise<number>;
}

/** Public maintenance use cases of identity, run by the worker as separate jobs. */
export interface IdentityMaintenanceApi {
  purgeExpiredOtpCodes(): Promise<number>;
  purgeEndedSessions(): Promise<number>;
  purgeRateLimitWindows(): Promise<number>;
  expireUnverifiedRegistrations(): Promise<number>;
}
