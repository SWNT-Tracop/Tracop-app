import { bigint, index, pgSchema, timestamp } from 'drizzle-orm/pg-core';

const messaging = pgSchema('messaging');

export const processedUpdates = messaging.table(
  'processed_updates',
  {
    updateId: bigint('update_id', { mode: 'bigint' }).primaryKey(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('processed_updates_received_at_idx').on(table.receivedAt)],
);
