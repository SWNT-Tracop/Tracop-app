import {
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

const identity = pgSchema('identity');
const shared = pgSchema('shared');

export const users = identity.table(
  'users',
  {
    id: uuid('id').primaryKey(),
    role: text('role').notNull(),
    fullName: text('full_name').notNull(),
    phone: text('phone').notNull(),
    status: text('status').notNull(),
    locale: text('locale').notNull().default('es-CO'),
    phoneVerifiedAt: timestamp('phone_verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('users_phone_unique').on(table.phone),
    check(
      'users_role_check',
      sql`${table.role} IN ('producer','supplier','buyer','carrier','operator','finance','admin')`,
    ),
    check(
      'users_status_check',
      sql`${table.status} IN ('pending_verification','active','suspended')`,
    ),
  ],
);

export const channelLinks = identity.table(
  'channel_links',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    channel: text('channel').notNull(),
    channelUserId: text('channel_user_id').notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('channel_links_channel_user_unique').on(table.channel, table.channelUserId),
    index('channel_links_user_id_idx').on(table.userId),
  ],
);

export const devices = identity.table(
  'devices',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    platform: text('platform').notNull(),
    pushToken: text('push_token'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('devices_user_id_id_unique').on(table.userId, table.id),
    index('devices_user_id_idx').on(table.userId),
  ],
);

export const otpCodes = identity.table(
  'otp_codes',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    codeHash: text('code_hash').notNull(),
    purpose: text('purpose').notNull(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    check('otp_codes_purpose_check', sql`${table.purpose} IN ('registration','login')`),
    index('otp_codes_user_purpose_created_idx').on(table.userId, table.purpose, table.createdAt),
  ],
);

export const sessions = identity.table(
  'sessions',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    deviceId: uuid('device_id').notNull(),
    familyId: uuid('family_id').notNull(),
    refreshHash: text('refresh_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('sessions_refresh_hash_unique').on(table.refreshHash),
    index('sessions_family_id_idx').on(table.familyId),
    index('sessions_user_id_idx').on(table.userId),
    uniqueIndex('sessions_one_live_device_token_unique')
      .on(table.userId, table.deviceId)
      .where(sql`${table.revokedAt} IS NULL AND ${table.rotatedAt} IS NULL`),
    foreignKey({
      columns: [table.userId, table.deviceId],
      foreignColumns: [devices.userId, devices.id],
      name: 'sessions_user_device_fkey',
    }),
  ],
);

export const providerProfiles = identity.table('provider_profiles', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id),
  displayName: text('display_name').notNull(),
  municipality: text('municipality'),
  department: text('department'),
  lat: doublePrecision('lat'),
  lng: doublePrecision('lng'),
  description: text('description'),
});

export const consents = identity.table(
  'consents',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    policyType: text('policy_type').notNull(),
    version: text('version').notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull(),
    channel: text('channel').notNull(),
  },
  (table) => [
    uniqueIndex('consents_user_policy_version_unique').on(
      table.userId,
      table.policyType,
      table.version,
    ),
    index('consents_user_id_idx').on(table.userId),
  ],
);

export const rateLimitCounters = identity.table(
  'rate_limit_counters',
  {
    keyHash: text('key_hash').primaryKey(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    count: integer('count').notNull(),
  },
  (table) => [check('rate_limit_counters_count_check', sql`${table.count} >= 0`)],
);

export const outboxEvents = shared.table('outbox_events', {
  id: uuid('id').primaryKey(),
  aggregate: text('aggregate').notNull(),
  type: text('type').notNull(),
  payload: jsonb('payload').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
});
