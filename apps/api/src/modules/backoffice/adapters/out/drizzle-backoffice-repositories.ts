import { createHmac } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import { jsonb, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { DatabaseService } from '../../../../shared/infra/database.js';
import { currentRequestContext } from '../../../../shared/infra/request-context.js';
import { createId } from '../../../../shared/kernel/ids.js';
import type { Clock } from '../../../../shared/kernel/clock.js';
import type { ParameterKey } from '../../../../shared/kernel/parameter-keys.js';
import type { AuditEntryInput, AuditWriter } from '../../../../shared/ports/audit-writer.js';
import type { ParameterReader } from '../../../../shared/ports/parameter-reader.js';
import type {
  AuditFilter,
  AuditQueryRepository,
  AuditRecord,
  ParameterDefaults,
  ParameterRepository,
  StoredParameter,
} from '../../ports/backoffice-ports.js';

const backoffice = pgSchema('backoffice');
const at = (name: string) => timestamp(name, { withTimezone: true });

export const auditLog = backoffice.table('audit_log', {
  id: uuid('id').primaryKey(),
  actorId: uuid('actor_id'),
  actorRole: text('actor_role').notNull(),
  action: text('action').notNull(),
  entity: text('entity').notNull(),
  entityId: text('entity_id').notNull(),
  before: jsonb('before').$type<Record<string, unknown> | null>(),
  after: jsonb('after').$type<Record<string, unknown> | null>(),
  at: at('at').notNull(),
  ipHash: text('ip_hash'),
  requestId: uuid('request_id'),
});

export const parametersTable = backoffice.table('parameters', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedBy: uuid('updated_by').notNull(),
  updatedAt: at('updated_at').notNull(),
});

const toParameter = (row: typeof parametersTable.$inferSelect): StoredParameter => ({
  key: row.key as ParameterKey,
  value: BigInt(row.value),
  updatedBy: row.updatedBy,
  updatedAt: row.updatedAt,
});

/**
 * Writes audit entries in the caller's transaction. The request context gives the request id
 * and the client IP, which is stored only as an HMAC keyed with RATE_LIMIT_HMAC_SECRET.
 */
export class DrizzleAuditWriter implements AuditWriter {
  constructor(
    private readonly database: DatabaseService,
    private readonly clock: Clock,
    private readonly hmacSecret: string,
  ) {}

  async record(entry: AuditEntryInput): Promise<void> {
    const context = currentRequestContext();
    await this.database
      .current()
      .insert(auditLog)
      .values({
        id: createId(),
        actorId: entry.actorId,
        actorRole: entry.actorRole,
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId,
        before: entry.before ? { ...entry.before } : null,
        after: entry.after ? { ...entry.after } : null,
        at: this.clock.now(),
        ipHash: context?.clientIp
          ? createHmac('sha256', this.hmacSecret).update(context.clientIp).digest('hex')
          : null,
        requestId: context?.requestId ?? null,
      });
  }
}

@Injectable()
export class DrizzleParameterRepository implements ParameterRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async find(key: ParameterKey, lock = false): Promise<StoredParameter | null> {
    // A row lock does not exist before the first change, so changes to one key are serialized
    // with a transaction-scoped advisory lock instead.
    if (lock)
      await this.database
        .current()
        .execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`backoffice.parameter:${key}`}))`);
    const [row] = await this.database
      .current()
      .select()
      .from(parametersTable)
      .where(eq(parametersTable.key, key));
    return row ? toParameter(row) : null;
  }

  async findAll(): Promise<readonly StoredParameter[]> {
    return (await this.database.current().select().from(parametersTable)).map(toParameter);
  }

  async upsert(parameter: StoredParameter): Promise<void> {
    const values = {
      value: parameter.value.toString(),
      updatedBy: parameter.updatedBy,
      updatedAt: parameter.updatedAt,
    };
    await this.database
      .current()
      .insert(parametersTable)
      .values({ key: parameter.key, ...values })
      .onConflictDoUpdate({ target: parametersTable.key, set: values });
  }
}

/** Stored value if the staff set one, otherwise the environment default. Read each time. */
export class StoredParameterReader implements ParameterReader {
  constructor(
    private readonly repository: ParameterRepository,
    private readonly defaults: ParameterDefaults,
  ) {}

  async get(key: ParameterKey): Promise<bigint> {
    return (await this.repository.find(key))?.value ?? this.defaults[key];
  }
}

@Injectable()
export class DrizzleAuditQueryRepository implements AuditQueryRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async list(
    filter: AuditFilter,
    cursor: { readonly at: Date; readonly id: string } | null,
    limit: number,
  ): Promise<readonly AuditRecord[]> {
    const rows = await this.database
      .current()
      .select({
        id: auditLog.id,
        actorId: auditLog.actorId,
        actorRole: auditLog.actorRole,
        action: auditLog.action,
        entity: auditLog.entity,
        entityId: auditLog.entityId,
        before: auditLog.before,
        after: auditLog.after,
        at: auditLog.at,
      })
      .from(auditLog)
      .where(
        and(
          filter.entity ? eq(auditLog.entity, filter.entity) : undefined,
          filter.entityId ? eq(auditLog.entityId, filter.entityId) : undefined,
          filter.actorId ? eq(auditLog.actorId, filter.actorId) : undefined,
          filter.action ? eq(auditLog.action, filter.action) : undefined,
          cursor
            ? or(
                lt(auditLog.at, cursor.at),
                and(eq(auditLog.at, cursor.at), lt(auditLog.id, cursor.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(auditLog.at), desc(auditLog.id))
      .limit(limit);
    return rows.map((row) => ({ ...row, before: row.before ?? null, after: row.after ?? null }));
  }
}
