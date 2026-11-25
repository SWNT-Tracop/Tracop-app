import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DatabaseService } from '../../../../shared/infra/database.js';
import { bogotaDay } from '../../domain/dates.js';
import type {
  DraftFields,
  DraftQuestion,
  DraftStatus,
  LotDraftProps,
} from '../../domain/lot-draft.js';
import type {
  DraftRepository,
  InboxItem,
  InboxPayload,
  InboxRepository,
  UsageRecord,
  UsageRepository,
} from '../../ports/assistant-ports.js';

type Row = Record<string, unknown>;

/** Channel the worker LISTENs to; NOTIFY is delivered only when the transaction commits. */
export const INBOX_NOTIFY_CHANNEL = 'ai_assistant_inbox';
const RETRY_BASE_SECONDS = 5;
const RETRY_MAX_SECONDS = 300;

class Rows {
  constructor(private readonly database: DatabaseService) {}

  async query(query: ReturnType<typeof sql>): Promise<Row[]> {
    return (await this.database.current().execute(query)).rows as Row[];
  }
}

const toDraft = (row: Row): LotDraftProps => ({
  id: String(row.id),
  shortCode: Number(row.short_code),
  userId: String(row.user_id),
  status: row.status as DraftStatus,
  version: Number(row.version),
  fields: row.fields as DraftFields,
  question: (row.question as DraftQuestion | null) ?? null,
  lotId: String(row.lot_id),
  expiresAt: new Date(row.expires_at as string),
  createdAt: new Date(row.created_at as string),
  updatedAt: new Date(row.updated_at as string),
});

@Injectable()
export class DrizzleDraftRepository implements DraftRepository {
  private readonly rows: Rows;

  constructor(@Inject(DatabaseService) database: DatabaseService) {
    this.rows = new Rows(database);
  }

  async lockUser(userId: string): Promise<void> {
    await this.rows.query(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`ai_assistant.user:${userId}`}))`,
    );
  }

  async findActive(userId: string): Promise<LotDraftProps | null> {
    const [row] = await this.rows.query(sql`
      SELECT * FROM ai_assistant.lot_drafts
      WHERE user_id = ${userId}::uuid AND status IN ('collecting', 'awaiting_confirmation')
      FOR UPDATE`);
    return row ? toDraft(row) : null;
  }

  async findByShortCode(shortCode: number): Promise<LotDraftProps | null> {
    const [row] = await this.rows.query(
      sql`SELECT * FROM ai_assistant.lot_drafts WHERE short_code = ${shortCode}`,
    );
    return row ? toDraft(row) : null;
  }

  async nextShortCode(): Promise<number> {
    const [row] = await this.rows.query(
      sql`SELECT nextval('ai_assistant.lot_drafts_short_code_seq') AS code`,
    );
    return Number(row!.code);
  }

  async insert(draft: LotDraftProps): Promise<void> {
    await this.rows.query(sql`
      INSERT INTO ai_assistant.lot_drafts
        (id, short_code, user_id, status, version, fields, question, lot_id, expires_at, created_at, updated_at)
      VALUES (${draft.id}::uuid, ${draft.shortCode}, ${draft.userId}::uuid, ${draft.status}, ${draft.version},
        ${JSON.stringify(draft.fields)}::jsonb, ${draft.question}, ${draft.lotId}::uuid,
        ${draft.expiresAt.toISOString()}::timestamptz, ${draft.createdAt.toISOString()}::timestamptz,
        ${draft.updatedAt.toISOString()}::timestamptz)`);
  }

  async update(draft: LotDraftProps, expectedVersion: number): Promise<boolean> {
    const rows = await this.rows.query(sql`
      UPDATE ai_assistant.lot_drafts
      SET status = ${draft.status}, version = ${draft.version}, fields = ${JSON.stringify(draft.fields)}::jsonb,
          question = ${draft.question}, expires_at = ${draft.expiresAt.toISOString()}::timestamptz,
          updated_at = ${draft.updatedAt.toISOString()}::timestamptz
      WHERE id = ${draft.id}::uuid AND version = ${expectedVersion}
      RETURNING id`);
    return rows.length === 1;
  }

  async expireDue(now: Date, limit: number): Promise<number> {
    const rows = await this.rows.query(sql`
      UPDATE ai_assistant.lot_drafts
      SET status = 'expired', version = version + 1, fields = '{}'::jsonb, question = NULL,
          updated_at = ${now.toISOString()}::timestamptz
      WHERE id IN (
        SELECT id FROM ai_assistant.lot_drafts
        WHERE status IN ('collecting', 'awaiting_confirmation')
          AND expires_at <= ${now.toISOString()}::timestamptz
        ORDER BY expires_at LIMIT ${limit}
        FOR UPDATE SKIP LOCKED)
      RETURNING id`);
    return rows.length;
  }

  async purgeFinishedBefore(cutoff: Date, limit: number): Promise<number> {
    const rows = await this.rows.query(sql`
      DELETE FROM ai_assistant.lot_drafts
      WHERE id IN (
        SELECT id FROM ai_assistant.lot_drafts
        WHERE status NOT IN ('collecting', 'awaiting_confirmation')
          AND updated_at < ${cutoff.toISOString()}::timestamptz
        ORDER BY updated_at LIMIT ${limit})
      RETURNING id`);
    return rows.length;
  }
}

@Injectable()
export class DrizzleInboxRepository implements InboxRepository {
  private readonly rows: Rows;

  constructor(@Inject(DatabaseService) database: DatabaseService) {
    this.rows = new Rows(database);
  }

  async enqueue(item: {
    readonly id: string;
    readonly channel: string;
    readonly channelUserId: string;
    readonly payload: InboxPayload;
    readonly receivedAt: Date;
    readonly availableAt: Date;
  }): Promise<void> {
    await this.rows.query(sql`
      INSERT INTO ai_assistant.inbox (id, channel, channel_user_id, payload, received_at, available_at)
      VALUES (${item.id}::uuid, ${item.channel}, ${item.channelUserId}, ${JSON.stringify(item.payload)}::jsonb,
        ${item.receivedAt.toISOString()}::timestamptz, ${item.availableAt.toISOString()}::timestamptz)`);
    await this.rows.query(sql`SELECT pg_notify(${INBOX_NOTIFY_CHANNEL}, '')`);
  }

  async leaseNext(now: Date, leaseSeconds: number): Promise<InboxItem | null> {
    const at = now.toISOString();
    const [row] = await this.rows.query(sql`
      UPDATE ai_assistant.inbox
      SET lease_token = ${randomUUID()}::uuid,
          lease_until = ${at}::timestamptz + make_interval(secs => ${leaseSeconds}),
          attempts = attempts + 1
      WHERE id = (
        SELECT i.id FROM ai_assistant.inbox i
        WHERE i.available_at <= ${at}::timestamptz
          AND (i.lease_until IS NULL OR i.lease_until < ${at}::timestamptz)
          AND NOT EXISTS (
            SELECT 1 FROM ai_assistant.inbox older
            WHERE older.channel = i.channel AND older.channel_user_id = i.channel_user_id
              AND older.seq < i.seq)
        ORDER BY i.seq LIMIT 1
        FOR UPDATE SKIP LOCKED)
      RETURNING id, channel, channel_user_id, payload, received_at, attempts, lease_token`);
    if (!row) return null;
    return {
      id: String(row.id),
      channel: String(row.channel),
      channelUserId: String(row.channel_user_id),
      payload: row.payload as InboxPayload,
      receivedAt: new Date(row.received_at as string),
      attempts: Number(row.attempts),
      leaseToken: String(row.lease_token),
    };
  }

  async complete(id: string, leaseToken: string): Promise<void> {
    await this.rows.query(sql`
      DELETE FROM ai_assistant.inbox WHERE id = ${id}::uuid AND lease_token = ${leaseToken}::uuid`);
  }

  async release(id: string, leaseToken: string, now: Date): Promise<void> {
    await this.rows.query(sql`
      UPDATE ai_assistant.inbox
      SET lease_token = NULL, lease_until = NULL,
          available_at = ${now.toISOString()}::timestamptz
            + make_interval(secs => LEAST(${RETRY_MAX_SECONDS}, ${RETRY_BASE_SECONDS} * power(2, attempts - 1)))
      WHERE id = ${id}::uuid AND lease_token = ${leaseToken}::uuid`);
  }

  async deleteExhausted(maxAttempts: number): Promise<number> {
    const rows = await this.rows.query(sql`
      DELETE FROM ai_assistant.inbox
      WHERE attempts >= ${maxAttempts} AND lease_token IS NULL
      RETURNING id`);
    return rows.length;
  }
}

@Injectable()
export class DrizzleUsageRepository implements UsageRepository {
  private readonly rows: Rows;

  constructor(@Inject(DatabaseService) database: DatabaseService) {
    this.rows = new Rows(database);
  }

  async record(usage: UsageRecord): Promise<void> {
    await this.rows.query(sql`
      INSERT INTO ai_assistant.usage
        (id, user_id, day, purpose, input_tokens, output_tokens, latency_ms, outcome, created_at)
      VALUES (${usage.id}::uuid, ${usage.userId}::uuid, ${bogotaDay(usage.at)}::date, ${usage.purpose},
        ${usage.inputTokens}, ${usage.outputTokens}, ${usage.latencyMs}, ${usage.outcome},
        ${usage.at.toISOString()}::timestamptz)`);
  }

  async countForDay(userId: string, day: string): Promise<number> {
    const [row] = await this.rows.query(sql`
      SELECT count(*)::int AS calls FROM ai_assistant.usage
      WHERE user_id = ${userId}::uuid AND day = ${day}::date AND outcome <> 'budget_exhausted'`);
    return Number(row?.calls ?? 0);
  }

  async reserve(month: string, tokens: number, cap: number): Promise<boolean> {
    await this.rows.query(sql`
      INSERT INTO ai_assistant.monthly_budget (month) VALUES (${month}::date) ON CONFLICT DO NOTHING`);
    const rows = await this.rows.query(sql`
      UPDATE ai_assistant.monthly_budget
      SET reserved_tokens = reserved_tokens + ${tokens}
      WHERE month = ${month}::date AND used_tokens + reserved_tokens + ${tokens} <= ${cap}
      RETURNING month`);
    return rows.length === 1;
  }

  async settle(month: string, reserved: number, used: number): Promise<void> {
    await this.rows.query(sql`
      UPDATE ai_assistant.monthly_budget
      SET reserved_tokens = GREATEST(0, reserved_tokens - ${reserved}),
          used_tokens = used_tokens + ${used}
      WHERE month = ${month}::date`);
  }

  async purgeBefore(cutoff: Date, limit: number): Promise<number> {
    const rows = await this.rows.query(sql`
      DELETE FROM ai_assistant.usage
      WHERE id IN (
        SELECT id FROM ai_assistant.usage WHERE created_at < ${cutoff.toISOString()}::timestamptz
        ORDER BY created_at LIMIT ${limit})
      RETURNING id`);
    return rows.length;
  }
}
