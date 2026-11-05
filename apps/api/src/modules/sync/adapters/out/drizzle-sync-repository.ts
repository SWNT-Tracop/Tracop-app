import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DatabaseService } from '../../../../shared/infra/database.js';
import type {
  ChangeRecord,
  ProcessedOperation,
  SyncRepositoryPort,
} from '../../ports/sync-ports.js';
import { changeLog, processedOperations } from './drizzle-schema.js';

const OP_LOCK_NAMESPACE = 1_414_677_711;
const SEQUENCE_LOCK_NAMESPACE = 1_414_677_712;

@Injectable()
export class DrizzleSyncRepository implements SyncRepositoryPort {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async acquireOperationLock(opId: string): Promise<void> {
    await this.database
      .current()
      .execute(sql`SELECT pg_advisory_xact_lock(${OP_LOCK_NAMESPACE}, hashtext(${opId}))`);
  }

  async findProcessed(opId: string): Promise<ProcessedOperation | null> {
    const [row] = await this.database
      .current()
      .select()
      .from(processedOperations)
      .where(eq(processedOperations.opId, opId))
      .limit(1);
    if (!row) return null;
    return {
      opId: row.opId,
      deviceId: row.deviceId,
      userId: row.userId,
      entity: row.entity,
      entityId: row.entityId,
      result: row.result as unknown as ProcessedOperation['result'],
      errorCode: row.errorCode,
      payloadHash: row.payloadHash,
      serverSeq: row.serverSeq?.toString() ?? null,
    };
  }

  async saveProcessed(operation: ProcessedOperation): Promise<void> {
    await this.database
      .current()
      .insert(processedOperations)
      .values({
        opId: operation.opId,
        deviceId: operation.deviceId,
        userId: operation.userId,
        entity: operation.entity,
        entityId: operation.entityId,
        result: operation.result as unknown as Record<string, unknown>,
        errorCode: operation.errorCode,
        payloadHash: operation.payloadHash,
        serverSeq: operation.serverSeq === null ? null : BigInt(operation.serverSeq),
        processedAt: new Date(),
      });
  }

  async appendChange(change: ChangeRecord): Promise<string> {
    await this.acquireSequenceLock();
    return this.insertChange(change);
  }

  async appendBaselineIfAbsent(change: ChangeRecord): Promise<string | null> {
    await this.acquireSequenceLock();
    if (await this.hasEntityHistory(change.entity, change.entityId)) return null;
    return this.insertChange(change);
  }

  async hasEntityHistory(entity: string, entityId: string): Promise<boolean> {
    const [row] = await this.database
      .current()
      .select({ serverSeq: changeLog.serverSeq })
      .from(changeLog)
      .where(and(eq(changeLog.entity, entity), eq(changeLog.entityId, entityId)))
      .limit(1);
    return row !== undefined;
  }

  async latestChangeSeq(
    entity: string,
    entityId: string,
    ownerUserId: string,
  ): Promise<string | null> {
    const [row] = await this.database
      .current()
      .select({ serverSeq: changeLog.serverSeq })
      .from(changeLog)
      .where(
        and(
          eq(changeLog.entity, entity),
          eq(changeLog.entityId, entityId),
          eq(changeLog.ownerUserId, ownerUserId),
        ),
      )
      .orderBy(sql`${changeLog.serverSeq} DESC`)
      .limit(1);
    return row?.serverSeq.toString() ?? null;
  }

  async pull(input: { userId: string; cursor: string; limit: number }) {
    const result = await this.database.current().execute(sql`
      WITH horizon AS (
        SELECT GREATEST(COALESCE(MAX(server_seq), 0), ${input.cursor}::bigint) AS seq
        FROM sync.change_log
      ), page AS (
        SELECT server_seq, entity, entity_id, op, payload, occurred_at
        FROM sync.change_log
        WHERE server_seq > ${input.cursor}::bigint
          AND (owner_user_id IS NULL OR owner_user_id = ${input.userId}::uuid)
        ORDER BY server_seq
        LIMIT ${input.limit + 1}
      )
      SELECT page.server_seq, page.entity, page.entity_id, page.op, page.payload,
             page.occurred_at, horizon.seq AS horizon_seq
      FROM horizon LEFT JOIN page ON TRUE
      ORDER BY page.server_seq NULLS LAST
    `);
    const rows = result.rows as Array<{
      server_seq: string | bigint | null;
      entity: string | null;
      entity_id: string | null;
      op: string | null;
      payload: Record<string, unknown> | null;
      occurred_at: Date | null;
      horizon_seq: string | bigint;
    }>;
    const visible = rows.filter((row) => row.server_seq !== null);
    const hasMore = visible.length > input.limit;
    const selected = visible.slice(0, input.limit);
    const horizon = String(rows[0]?.horizon_seq ?? input.cursor);
    const nextCursor = hasMore ? String(selected.at(-1)!.server_seq) : horizon;
    return {
      changes: selected.map((row) => ({
        serverSeq: String(row.server_seq),
        entity: row.entity!,
        entityId: row.entity_id!,
        op: row.op!,
        payload: row.payload!,
        occurredAt: row.occurred_at!,
      })),
      nextCursor,
      hasMore,
    };
  }

  private async acquireSequenceLock(): Promise<void> {
    await this.database
      .current()
      .execute(sql`SELECT pg_advisory_xact_lock(${SEQUENCE_LOCK_NAMESPACE}, 1)`);
  }

  private async insertChange(change: ChangeRecord): Promise<string> {
    const [inserted] = await this.database
      .current()
      .insert(changeLog)
      .values({
        entity: change.entity,
        entityId: change.entityId,
        op: change.op,
        payload: change.payload,
        ownerUserId: change.ownerUserId,
        occurredAt: change.occurredAt,
      })
      .returning({ serverSeq: changeLog.serverSeq });
    if (!inserted) throw new Error('Failed to record sync change.');
    return inserted.serverSeq.toString();
  }
}
