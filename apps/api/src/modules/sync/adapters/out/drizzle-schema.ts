import { bigint, jsonb, pgSchema, text, timestamp, uuid, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

const sync = pgSchema('sync');

export const processedOperations = sync.table('processed_operations', {
  opId: uuid('op_id').primaryKey(),
  deviceId: uuid('device_id').notNull(),
  userId: uuid('user_id').notNull(),
  entity: text('entity').notNull(),
  entityId: uuid('entity_id').notNull(),
  result: jsonb('result').$type<Record<string, unknown>>().notNull(),
  errorCode: text('error_code'),
  payloadHash: text('payload_hash').notNull(),
  serverSeq: bigint('server_seq', { mode: 'bigint' }),
  processedAt: timestamp('processed_at', { withTimezone: true }).notNull(),
});

export const changeLog = sync.table(
  'change_log',
  {
    serverSeq: bigint('server_seq', { mode: 'bigint' })
      .primaryKey()
      .default(sql`nextval('sync.change_log_server_seq_seq')`),
    entity: text('entity').notNull(),
    entityId: uuid('entity_id').notNull(),
    op: text('op').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    ownerUserId: uuid('owner_user_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('change_log_owner_server_seq_idx').on(table.ownerUserId, table.serverSeq)],
);
