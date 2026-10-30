import type { Result } from '../../src/shared/kernel/result.js';
import { DomainError } from '../../src/shared/kernel/domain-error.js';
import type { Clock } from '../../src/shared/kernel/clock.js';
import type {
  AccessTokenClaims,
  ConsentRepository,
  DeviceRepository,
  IdentitySettings,
  IdentityUnitOfWork,
  OtpRepository,
  PasswordlessHasherPort,
  RateLimiterPort,
  RateLimitResult,
  SessionRepository,
  TokenServicePort,
  UserRepository,
} from '../../src/modules/identity/ports/identity-ports.js';
import type { OutboxEventInput, OutboxWriter } from '../../src/shared/ports/outbox-writer.js';
import type { BackgroundDispatcher } from '../../src/shared/ports/background-dispatcher.js';
import type { OtpPurpose, OtpProps } from '../../src/modules/identity/domain/otp.js';
import type { SessionProps } from '../../src/modules/identity/domain/session.js';
import type { UserProps } from '../../src/modules/identity/domain/user.js';
import type { PhoneNumber } from '../../src/modules/identity/domain/phone-number.js';
import { InMemoryOtpSender } from '../../src/modules/identity/adapters/out/otp-senders.js';

export class MemoryBackgroundDispatcher implements BackgroundDispatcher {
  private readonly tasks: Promise<void>[] = [];

  dispatch(task: () => Promise<void>): void {
    this.tasks.push(task());
  }

  async flush(): Promise<void> {
    await Promise.allSettled(this.tasks);
  }
}

export class FixedClock implements Clock {
  constructor(public time = new Date('2026-01-01T00:00:00.000Z')) {}
  now(): Date {
    return new Date(this.time);
  }
  advance(seconds: number): void {
    this.time = new Date(this.time.getTime() + seconds * 1000);
  }
}

export class MemoryState {
  readonly users = new Map<string, UserProps>();
  readonly otps = new Map<string, OtpProps>();
  readonly sessions = new Map<string, SessionProps>();
  readonly devices = new Map<string, string>();
  readonly consents = new Map<
    string,
    {
      id: string;
      userId: string;
      policyType: string;
      version: string;
      acceptedAt: Date;
      channel: string;
    }
  >();
  readonly outbox: OutboxEventInput[] = [];
  readonly rateCounters = new Map<string, { startedAt: number; count: number }>();
}

export class MemoryUserRepository implements UserRepository {
  constructor(private readonly state: MemoryState) {}
  async findByPhone(phone: PhoneNumber): Promise<UserProps | null> {
    return [...this.state.users.values()].find((user) => user.phone.equals(phone)) ?? null;
  }
  async findById(id: string): Promise<UserProps | null> {
    return this.state.users.get(id) ?? null;
  }
  async create(user: UserProps): Promise<void> {
    this.state.users.set(user.id, user);
  }
  async update(user: UserProps): Promise<void> {
    this.state.users.set(user.id, user);
  }
}

export class MemoryOtpRepository implements OtpRepository {
  constructor(private readonly state: MemoryState) {}
  async create(otp: OtpProps): Promise<void> {
    this.state.otps.set(otp.id, otp);
  }
  async findLatestForUpdate(userId: string, purpose: OtpPurpose): Promise<OtpProps | null> {
    return (
      [...this.state.otps.values()]
        .filter((otp) => otp.userId === userId && otp.purpose === purpose && !otp.consumedAt)
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0] ?? null
    );
  }
  async update(otp: OtpProps): Promise<void> {
    this.state.otps.set(otp.id, otp);
  }
}

export class MemorySessionRepository implements SessionRepository {
  constructor(private readonly state: MemoryState) {}
  async create(session: SessionProps): Promise<void> {
    this.state.sessions.set(session.id, session);
  }
  async findByRefreshHashForUpdate(hash: string): Promise<SessionProps | null> {
    return (
      [...this.state.sessions.values()].find((session) => session.refreshHash === hash) ?? null
    );
  }
  async findById(id: string): Promise<SessionProps | null> {
    return this.state.sessions.get(id) ?? null;
  }
  async findFamilyForDevice(userId: string, deviceId: string): Promise<string | null> {
    return (
      [...this.state.sessions.values()].find(
        (session) =>
          session.userId === userId && session.deviceId === deviceId && !session.revokedAt,
      )?.familyId ?? null
    );
  }
  async update(session: SessionProps): Promise<void> {
    this.state.sessions.set(session.id, session);
  }
  async revokeFamily(
    familyId: string,
    now: Date,
    reason: string,
  ): Promise<readonly SessionProps[]> {
    const sessions = [...this.state.sessions.values()].filter(
      (session) => session.familyId === familyId && !session.revokedAt,
    );
    for (const session of sessions) {
      session.revokedAt = now;
      session.revokedReason = reason;
    }
    return sessions;
  }
  async revokeSession(id: string, now: Date, reason: string): Promise<SessionProps | null> {
    const session = this.state.sessions.get(id);
    if (!session || session.revokedAt) return null;
    session.revokedAt = now;
    session.revokedReason = reason;
    return session;
  }
}

export class MemoryDeviceRepository implements DeviceRepository {
  constructor(private readonly state: MemoryState) {}
  async upsert(input: {
    id: string;
    userId: string;
    platform: 'ios' | 'android' | 'web' | 'other';
    lastSeenAt: Date;
  }): Promise<void> {
    if (!this.state.devices.has(input.id)) this.state.devices.set(input.id, input.userId);
  }
  async belongsToUser(deviceId: string, userId: string): Promise<boolean> {
    return this.state.devices.get(deviceId) === userId;
  }
}

export class MemoryConsentRepository implements ConsentRepository {
  constructor(private readonly state: MemoryState) {}
  async create(input: {
    id: string;
    userId: string;
    policyType: string;
    version: string;
    acceptedAt: Date;
    channel: string;
  }): Promise<void> {
    const key = `${input.userId}:${input.policyType}:${input.version}`;
    if (!this.state.consents.has(key)) this.state.consents.set(key, input);
  }
}

export class MemoryRateLimiter implements RateLimiterPort {
  constructor(
    private readonly state: MemoryState,
    private readonly clock: Clock,
  ) {}
  async consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const now = this.clock.now().getTime();
    const current = this.state.rateCounters.get(key);
    const expired = !current || now - current.startedAt >= windowSeconds * 1000;
    const next = expired
      ? { startedAt: now, count: 1 }
      : { ...current, count: Math.min(current.count + 1, limit + 1) };
    this.state.rateCounters.set(key, next);
    return {
      allowed: next.count <= limit,
      retryAfter: Math.max(1, Math.ceil((next.startedAt + windowSeconds * 1000 - now) / 1000)),
    };
  }
}

export class MemoryUnitOfWork implements IdentityUnitOfWork {
  async run<T>(operation: () => Promise<T>): Promise<T> {
    return operation();
  }
}

export class MemoryOutboxWriter implements OutboxWriter {
  constructor(private readonly state: MemoryState) {}
  async append(events: readonly OutboxEventInput[]): Promise<void> {
    this.state.outbox.push(...events);
  }
}

export class MemoryTokens implements TokenServicePort {
  private sequence = 0;
  private readonly claims = new Map<string, AccessTokenClaims>();
  async issueAccessToken(
    user: UserProps,
    sessionId: string,
    deviceId: string,
    now: Date,
  ): Promise<string> {
    const token = `access-${++this.sequence}`;
    this.claims.set(token, {
      sub: user.id,
      role: user.role,
      sid: sessionId,
      did: deviceId,
      jti: token,
      exp: Math.floor(now.getTime() / 1000) + 900,
    });
    return token;
  }
  async verifyAccessToken(token: string, now: Date): Promise<AccessTokenClaims | null> {
    const claims = this.claims.get(token);
    return claims && claims.exp > Math.floor(now.getTime() / 1000) ? claims : null;
  }
  createRefreshToken(): string {
    return `refresh-${++this.sequence}`;
  }
}

export class MemoryHasher implements PasswordlessHasherPort {
  hashOtp(phone: PhoneNumber, purpose: OtpPurpose, code: string): string {
    return `${phone.value}|${purpose}|${code}`;
  }
  verifyOtp(phone: PhoneNumber, purpose: OtpPurpose, code: string, hash: string): boolean {
    return this.hashOtp(phone, purpose, code) === hash;
  }
  hashRefreshToken(token: string): string {
    return `hash:${token}`;
  }
  hashRateLimitKey(key: string): string {
    return `hmac:${key}`;
  }
}

export const memorySettings: IdentitySettings = {
  NODE_ENV: 'test',
  PRIVACY_POLICY_VERSION: 'v0-draft',
  TELEGRAM_BOT_USERNAME: 'tracop_test_bot',
  allowedCountryCodes: ['57'],
  OTP_LENGTH: 6,
  OTP_TTL_SECONDS: 300,
  OTP_MAX_ATTEMPTS: 5,
  OTP_PHONE_LIMIT: 3,
  OTP_PHONE_WINDOW_SECONDS: 600,
  OTP_PHONE_COOLDOWN_SECONDS: 60,
  OTP_PHONE_COOLDOWN_LIMIT: 1,
  OTP_IP_REQUEST_LIMIT: 30,
  OTP_IP_VERIFY_LIMIT: 60,
  OTP_IP_WINDOW_SECONDS: 600,
  ACCESS_TOKEN_TTL_SECONDS: 900,
  REFRESH_TOKEN_TTL_SECONDS: 2_592_000,
};

export const unwrap = <T>(result: Result<T, DomainError>): T => {
  if (!result.ok) throw result.error;
  return result.value;
};

export { InMemoryOtpSender };
