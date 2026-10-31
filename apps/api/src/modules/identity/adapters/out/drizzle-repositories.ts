import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { DatabaseService } from '../../../../shared/infra/database.js';
import { APP_ENVIRONMENT, DATABASE_POOL } from '../../../../shared/infra/tokens.js';
import { PhoneNumber } from '../../domain/phone-number.js';
import type { OtpPurpose, OtpProps } from '../../domain/otp.js';
import type { SessionProps } from '../../domain/session.js';
import type { UserProps } from '../../domain/user.js';
import type { ChannelLinkProps, IdentityChannel } from '../../domain/channel-link.js';
import type {
  ChannelLinkRepository,
  ConsentRepository,
  DeviceRepository,
  OtpRepository,
  SessionRepository,
  UserRepository,
  ProviderProfileRepository,
} from '../../ports/identity-ports.js';
import type { RateLimitResult, RateLimiterPort } from '../../ports/identity-ports.js';
import { IDENTITY_HASHER } from '../../ports/tokens.js';
import {
  channelLinks,
  consents,
  devices,
  otpCodes,
  providerProfiles,
  sessions,
  users,
} from './drizzle-schema.js';
import type { ProviderProfileProps, ProviderPublicSummary } from '../../domain/provider-profile.js';
import type { Pool } from 'pg';

const mapUser = (
  row: typeof users.$inferSelect,
  allowedCountryCodes: readonly string[],
): UserProps => {
  const phone = PhoneNumber.parse(row.phone, allowedCountryCodes);
  if (!phone.ok) throw new Error('Persisted identity phone number is invalid.');
  return {
    id: row.id,
    phone: phone.value,
    role: row.role as UserProps['role'],
    fullName: row.fullName,
    locale: row.locale,
    status: row.status as UserProps['status'],
    phoneVerifiedAt: row.phoneVerifiedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
};

const mapOtp = (row: typeof otpCodes.$inferSelect): OtpProps => ({
  id: row.id,
  userId: row.userId,
  codeHash: row.codeHash,
  purpose: row.purpose as OtpPurpose,
  attempts: row.attempts,
  maxAttempts: row.maxAttempts,
  expiresAt: row.expiresAt,
  consumedAt: row.consumedAt,
  createdAt: row.createdAt,
});

const mapSession = (row: typeof sessions.$inferSelect): SessionProps => ({
  id: row.id,
  userId: row.userId,
  deviceId: row.deviceId,
  familyId: row.familyId,
  refreshHash: row.refreshHash,
  expiresAt: row.expiresAt,
  createdAt: row.createdAt,
  rotatedAt: row.rotatedAt,
  revokedAt: row.revokedAt,
  revokedReason: row.revokedReason,
  lastUsedAt: row.lastUsedAt,
});

const mapChannelLink = (row: typeof channelLinks.$inferSelect): ChannelLinkProps => ({
  id: row.id,
  userId: row.userId,
  channel: row.channel as IdentityChannel,
  channelUserId: row.channelUserId,
  verifiedAt: row.verifiedAt,
  createdAt: row.createdAt,
});

@Injectable()
export class DrizzleChannelLinkRepository implements ChannelLinkRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async findByChannelUser(
    channel: IdentityChannel,
    channelUserId: string,
  ): Promise<ChannelLinkProps | null> {
    const [row] = await this.database
      .current()
      .select()
      .from(channelLinks)
      .where(and(eq(channelLinks.channel, channel), eq(channelLinks.channelUserId, channelUserId)))
      .limit(1);
    return row ? mapChannelLink(row) : null;
  }

  async findVerifiedByPhone(phone: PhoneNumber): Promise<ChannelLinkProps | null> {
    const [row] = await this.database
      .current()
      .select({ link: channelLinks })
      .from(channelLinks)
      .innerJoin(users, eq(users.id, channelLinks.userId))
      .where(
        and(
          eq(users.phone, phone.value),
          isNull(users.deletedAt),
          sql`${channelLinks.verifiedAt} IS NOT NULL`,
        ),
      )
      .orderBy(desc(channelLinks.verifiedAt))
      .limit(1);
    return row ? mapChannelLink(row.link) : null;
  }

  async create(link: ChannelLinkProps): Promise<void> {
    await this.database.current().insert(channelLinks).values(link);
  }
}

@Injectable()
export class DrizzleUserRepository implements UserRepository {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(APP_ENVIRONMENT)
    private readonly environment: { allowedCountryCodes: readonly string[] },
  ) {}
  async findByPhone(phone: PhoneNumber): Promise<UserProps | null> {
    const [row] = await this.database
      .current()
      .select()
      .from(users)
      .where(and(eq(users.phone, phone.value), isNull(users.deletedAt)))
      .limit(1);
    return row ? mapUser(row, this.environment.allowedCountryCodes) : null;
  }
  async findById(id: string): Promise<UserProps | null> {
    const [row] = await this.database
      .current()
      .select()
      .from(users)
      .where(and(eq(users.id, id), isNull(users.deletedAt)))
      .limit(1);
    return row ? mapUser(row, this.environment.allowedCountryCodes) : null;
  }
  async create(user: UserProps): Promise<void> {
    await this.database.current().insert(users).values({
      id: user.id,
      role: user.role,
      fullName: user.fullName,
      phone: user.phone.value,
      status: user.status,
      locale: user.locale,
      phoneVerifiedAt: user.phoneVerifiedAt,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    });
  }
  async update(user: UserProps): Promise<void> {
    await this.database
      .current()
      .update(users)
      .set({
        fullName: user.fullName,
        locale: user.locale,
        status: user.status,
        phoneVerifiedAt: user.phoneVerifiedAt,
        updatedAt: user.updatedAt,
      })
      .where(eq(users.id, user.id));
  }
}

@Injectable()
export class DrizzleOtpRepository implements OtpRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}
  async create(otp: OtpProps): Promise<void> {
    await this.database
      .current()
      .insert(otpCodes)
      .values({ ...otp, purpose: otp.purpose });
  }
  async findLatestForUpdate(userId: string, purpose: OtpPurpose): Promise<OtpProps | null> {
    const [row] = await this.database
      .current()
      .select()
      .from(otpCodes)
      .where(
        and(
          eq(otpCodes.userId, userId),
          eq(otpCodes.purpose, purpose),
          isNull(otpCodes.consumedAt),
        ),
      )
      .orderBy(desc(otpCodes.createdAt))
      .limit(1)
      .for('update');
    return row ? mapOtp(row) : null;
  }
  async update(otp: OtpProps): Promise<void> {
    await this.database
      .current()
      .update(otpCodes)
      .set({ attempts: otp.attempts, consumedAt: otp.consumedAt })
      .where(eq(otpCodes.id, otp.id));
  }
}

@Injectable()
export class DrizzleSessionRepository implements SessionRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}
  async create(session: SessionProps): Promise<void> {
    await this.database.current().insert(sessions).values(session);
  }
  async findByRefreshHashForUpdate(refreshHash: string): Promise<SessionProps | null> {
    const [row] = await this.database
      .current()
      .select()
      .from(sessions)
      .where(eq(sessions.refreshHash, refreshHash))
      .limit(1)
      .for('update');
    return row ? mapSession(row) : null;
  }
  async findById(id: string): Promise<SessionProps | null> {
    const [row] = await this.database
      .current()
      .select()
      .from(sessions)
      .where(eq(sessions.id, id))
      .limit(1);
    return row ? mapSession(row) : null;
  }
  async findFamilyForDevice(userId: string, deviceId: string): Promise<string | null> {
    const [row] = await this.database
      .current()
      .select({ familyId: sessions.familyId })
      .from(sessions)
      .where(
        and(
          eq(sessions.userId, userId),
          eq(sessions.deviceId, deviceId),
          isNull(sessions.revokedAt),
        ),
      )
      .orderBy(desc(sessions.createdAt))
      .limit(1);
    return row?.familyId ?? null;
  }
  async update(session: SessionProps): Promise<void> {
    await this.database
      .current()
      .update(sessions)
      .set({
        rotatedAt: session.rotatedAt,
        revokedAt: session.revokedAt,
        revokedReason: session.revokedReason,
        lastUsedAt: session.lastUsedAt,
      })
      .where(eq(sessions.id, session.id));
  }
  async revokeFamily(
    familyId: string,
    now: Date,
    reason: string,
  ): Promise<readonly SessionProps[]> {
    const rows = await this.database
      .current()
      .update(sessions)
      .set({ revokedAt: now, revokedReason: reason })
      .where(and(eq(sessions.familyId, familyId), isNull(sessions.revokedAt)))
      .returning();
    return rows.map(mapSession);
  }
  async revokeSession(id: string, now: Date, reason: string): Promise<SessionProps | null> {
    const [row] = await this.database
      .current()
      .update(sessions)
      .set({ revokedAt: now, revokedReason: reason })
      .where(and(eq(sessions.id, id), isNull(sessions.revokedAt)))
      .returning();
    return row ? mapSession(row) : null;
  }
}

@Injectable()
export class DrizzleDeviceRepository implements DeviceRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}
  async upsert(input: {
    id: string;
    userId: string;
    platform: 'ios' | 'android' | 'web' | 'other';
    lastSeenAt: Date;
  }): Promise<void> {
    await this.database
      .current()
      .insert(devices)
      .values({
        id: input.id,
        userId: input.userId,
        platform: input.platform,
        pushToken: null,
        lastSeenAt: input.lastSeenAt,
        createdAt: input.lastSeenAt,
      })
      .onConflictDoUpdate({ target: devices.id, set: { lastSeenAt: input.lastSeenAt } });
  }
  async belongsToUser(deviceId: string, userId: string): Promise<boolean> {
    const [row] = await this.database
      .current()
      .select({ id: devices.id })
      .from(devices)
      .where(and(eq(devices.id, deviceId), eq(devices.userId, userId)))
      .limit(1);
    return Boolean(row);
  }
}

@Injectable()
export class DrizzleConsentRepository implements ConsentRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}
  async create(input: {
    id: string;
    userId: string;
    policyType: string;
    version: string;
    acceptedAt: Date;
    channel: string;
  }): Promise<void> {
    await this.database
      .current()
      .insert(consents)
      .values({
        id: input.id,
        userId: input.userId,
        policyType: input.policyType,
        version: input.version,
        acceptedAt: input.acceptedAt,
        channel: input.channel,
      })
      .onConflictDoNothing({ target: [consents.userId, consents.policyType, consents.version] });
  }
}

@Injectable()
export class DrizzleProviderProfileRepository implements ProviderProfileRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async upsert(profile: ProviderProfileProps): Promise<void> {
    await this.database
      .current()
      .insert(providerProfiles)
      .values(profile)
      .onConflictDoUpdate({
        target: providerProfiles.userId,
        set: {
          displayName: profile.displayName,
          municipality: profile.municipality,
          department: profile.department,
          lat: profile.lat,
          lng: profile.lng,
          description: profile.description,
        },
      });
  }

  async findPublicSummaries(
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, ProviderPublicSummary>> {
    if (ids.length > 50) throw new Error('Provider summary query exceeds the 50-id limit.');
    const rows = await this.database
      .current()
      .select({
        userId: providerProfiles.userId,
        displayName: providerProfiles.displayName,
        municipality: providerProfiles.municipality,
        department: providerProfiles.department,
      })
      .from(providerProfiles)
      .where(inArray(providerProfiles.userId, [...new Set(ids)]));
    return new Map(
      rows.map(({ userId, displayName, municipality, department }) => [
        userId,
        {
          displayName,
          municipality: municipality ?? '',
          department: department ?? '',
        },
      ]),
    );
  }
}

@Injectable()
export class PostgresRateLimiter implements RateLimiterPort {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(IDENTITY_HASHER) private readonly hasher: { hashRateLimitKey(key: string): string },
  ) {}

  async consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const keyHash = this.hasher.hashRateLimitKey(key);
    await this.pool.query(
      `DELETE FROM identity.rate_limit_counters
       WHERE key_hash = $1 AND window_start + ($2 * interval '1 second') <= clock_timestamp()`,
      [keyHash, windowSeconds],
    );
    const result = await this.pool.query<{ count: number; window_start: Date }>(
      `INSERT INTO identity.rate_limit_counters (key_hash, window_start, count)
       VALUES ($1, clock_timestamp(), 1)
       ON CONFLICT (key_hash)
       DO UPDATE SET
         window_start = CASE
           WHEN identity.rate_limit_counters.window_start + ($2 * interval '1 second') <= clock_timestamp()
             THEN clock_timestamp()
           ELSE identity.rate_limit_counters.window_start
         END,
         count = CASE
           WHEN identity.rate_limit_counters.window_start + ($2 * interval '1 second') <= clock_timestamp()
             THEN 1
           ELSE LEAST(identity.rate_limit_counters.count + 1, $3 + 1)
         END
       RETURNING count, window_start`,
      [keyHash, windowSeconds, limit],
    );
    const count = Number(result.rows[0]?.count ?? limit + 1);
    const windowStart = new Date(result.rows[0]?.window_start ?? Date.now());
    const retryAfter = Math.max(
      1,
      Math.ceil((windowStart.getTime() + windowSeconds * 1000 - Date.now()) / 1000),
    );
    return { allowed: count <= limit, retryAfter };
  }
}
