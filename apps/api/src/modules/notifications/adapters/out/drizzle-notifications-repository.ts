import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { integer, jsonb, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { DatabaseService } from '../../../../shared/infra/database.js';
import { createId } from '../../../../shared/kernel/ids.js';
import {
  DEFAULT_PREFERENCES,
  type DeliveryChannel,
  type NotificationKind,
  type NotificationPreferences,
  type PlannedDelivery,
  type QuietHours,
} from '../../domain/notification.js';
import type {
  DueDelivery,
  InboxEntry,
  NotificationRepository,
  NotificationsMetricsQuery,
} from '../../ports/notifications-ports.js';

const notifications = pgSchema('notifications');
const at = (name: string) => timestamp(name, { withTimezone: true });

export const preferencesTable = notifications.table('preferences', {
  userId: uuid('user_id').primaryKey(),
  channelOrder: jsonb('channel_order').$type<DeliveryChannel[]>().notNull(),
  quietHours: jsonb('quiet_hours').$type<QuietHours | null>(),
  updatedAt: at('updated_at').notNull(),
});

export const inboxTable = notifications.table('inbox', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull(),
  eventId: uuid('event_id').notNull(),
  kind: text('kind').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  templateVersion: text('template_version').notNull(),
  createdAt: at('created_at').notNull(),
  readAt: at('read_at'),
});

export const deliveriesTable = notifications.table('deliveries', {
  id: uuid('id').primaryKey(),
  inboxId: uuid('inbox_id').notNull(),
  userId: uuid('user_id').notNull(),
  eventId: uuid('event_id').notNull(),
  kind: text('kind').notNull(),
  channel: text('channel').notNull(),
  status: text('status').notNull(),
  attempts: integer('attempts').notNull(),
  nextAttemptAt: at('next_attempt_at'),
  lockedUntil: at('locked_until'),
  leaseToken: uuid('lease_token'),
  lastError: text('last_error'),
  sentAt: at('sent_at'),
  createdAt: at('created_at').notNull(),
  updatedAt: at('updated_at').notNull(),
});

const toEntry = (row: typeof inboxTable.$inferSelect): InboxEntry => ({
  ...row,
  kind: row.kind as NotificationKind,
});

@Injectable()
export class DrizzleNotificationRepository implements NotificationRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async insertNotification(
    entry: InboxEntry,
    deliveries: readonly PlannedDelivery[],
  ): Promise<boolean> {
    const inserted = await this.database
      .current()
      .insert(inboxTable)
      .values(entry)
      .onConflictDoNothing()
      .returning({ id: inboxTable.id });
    if (!inserted.length) return false;
    if (deliveries.length)
      await this.database
        .current()
        .insert(deliveriesTable)
        .values(
          deliveries.map((delivery) => ({
            id: createId(),
            inboxId: entry.id,
            userId: entry.userId,
            eventId: entry.eventId,
            kind: entry.kind,
            channel: delivery.channel,
            status: delivery.status,
            attempts: 0,
            nextAttemptAt: delivery.nextAttemptAt,
            createdAt: entry.createdAt,
            updatedAt: entry.createdAt,
          })),
        );
    return true;
  }

  async findPreferences(
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, NotificationPreferences>> {
    if (!userIds.length) return new Map();
    const rows = await this.database
      .current()
      .select()
      .from(preferencesTable)
      .where(inArray(preferencesTable.userId, [...userIds]));
    return new Map(
      rows.map((row) => [
        row.userId,
        {
          channelOrder: row.channelOrder ?? DEFAULT_PREFERENCES.channelOrder,
          quietHours: row.quietHours ?? null,
        },
      ]),
    );
  }

  async savePreferences(
    userId: string,
    preferences: NotificationPreferences,
    now: Date,
  ): Promise<void> {
    const values = {
      channelOrder: [...preferences.channelOrder],
      quietHours: preferences.quietHours,
      updatedAt: now,
    };
    await this.database
      .current()
      .insert(preferencesTable)
      .values({ userId, ...values })
      .onConflictDoUpdate({ target: preferencesTable.userId, set: values });
  }

  async listInbox(
    userId: string,
    cursor: { readonly createdAt: Date; readonly id: string } | null,
    limit: number,
  ): Promise<readonly InboxEntry[]> {
    const rows = await this.database
      .current()
      .select()
      .from(inboxTable)
      .where(
        and(
          eq(inboxTable.userId, userId),
          cursor
            ? or(
                lt(inboxTable.createdAt, cursor.createdAt),
                and(eq(inboxTable.createdAt, cursor.createdAt), lt(inboxTable.id, cursor.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(inboxTable.createdAt), desc(inboxTable.id))
      .limit(limit);
    return rows.map(toEntry);
  }

  async findInboxEntry(id: string): Promise<InboxEntry | null> {
    const [row] = await this.database
      .current()
      .select()
      .from(inboxTable)
      .where(eq(inboxTable.id, id));
    return row ? toEntry(row) : null;
  }

  async markRead(id: string, userId: string, now: Date): Promise<InboxEntry | null> {
    await this.database
      .current()
      .update(inboxTable)
      .set({ readAt: now })
      .where(and(eq(inboxTable.id, id), eq(inboxTable.userId, userId), isNull(inboxTable.readAt)));
    const [row] = await this.database
      .current()
      .select()
      .from(inboxTable)
      .where(and(eq(inboxTable.id, id), eq(inboxTable.userId, userId)));
    return row ? toEntry(row) : null;
  }

  async claimDue(now: Date, leaseUntil: Date, limit: number): Promise<readonly DueDelivery[]> {
    const leaseToken = randomUUID();
    const result = await this.database.current().execute(sql`
      UPDATE notifications.deliveries AS d
      SET locked_until = ${leaseUntil}, lease_token = ${leaseToken}::uuid, updated_at = ${now}
      FROM (
        SELECT id FROM notifications.deliveries
        WHERE status = 'pending' AND next_attempt_at <= ${now}
          AND (locked_until IS NULL OR locked_until < ${now})
        ORDER BY next_attempt_at, id
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      ) AS due
      WHERE d.id = due.id
      RETURNING d.id, d.inbox_id, d.user_id, d.channel, d.attempts, d.lease_token
    `);
    return (
      result.rows as {
        id: string;
        inbox_id: string;
        user_id: string;
        channel: DeliveryChannel;
        attempts: number;
        lease_token: string;
      }[]
    ).map((row) => ({
      id: row.id,
      inboxId: row.inbox_id,
      userId: row.user_id,
      channel: row.channel,
      attempts: row.attempts,
      leaseToken: row.lease_token,
    }));
  }

  async completeDelivery(input: {
    readonly id: string;
    readonly leaseToken: string;
    readonly status: 'sent' | 'failed' | 'pending';
    readonly attempts: number;
    readonly nextAttemptAt: Date | null;
    readonly lastError: string | null;
    readonly now: Date;
  }): Promise<boolean> {
    const rows = await this.database
      .current()
      .update(deliveriesTable)
      .set({
        status: input.status,
        attempts: input.attempts,
        nextAttemptAt: input.nextAttemptAt,
        lastError: input.lastError,
        sentAt: input.status === 'sent' ? input.now : null,
        lockedUntil: null,
        leaseToken: null,
        updatedAt: input.now,
      })
      .where(
        and(eq(deliveriesTable.id, input.id), eq(deliveriesTable.leaseToken, input.leaseToken)),
      )
      .returning({ id: deliveriesTable.id });
    return rows.length === 1;
  }
}

@Injectable()
export class DrizzleNotificationsMetricsQuery implements NotificationsMetricsQuery {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async deliveriesByStatus(): Promise<
    Readonly<Record<'pending' | 'sent' | 'failed' | 'skipped', number>>
  > {
    const result = await this.database.current().execute(sql`
      SELECT status, count(*)::int AS count FROM notifications.deliveries GROUP BY status
    `);
    const counts = { pending: 0, sent: 0, failed: 0, skipped: 0 };
    for (const row of result.rows as { status: keyof typeof counts; count: number }[])
      counts[row.status] = row.count;
    return counts;
  }
}
