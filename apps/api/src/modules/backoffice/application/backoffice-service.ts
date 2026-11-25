import { DomainError } from '../../../shared/kernel/domain-error.js';
import { PARAMETER_KEYS, type ParameterKey } from '../../../shared/kernel/parameter-keys.js';
import type { AuditWriter } from '../../../shared/ports/audit-writer.js';
import {
  PARAMETER_DEFINITIONS,
  isParameterKey,
  parseParameterValue,
  type ParameterDefinition,
} from '../domain/parameters.js';
import type {
  AuditFilter,
  AuditQueryRepository,
  AuditRecord,
  BackofficeMetrics,
  MetricsSourcesPort,
  BackofficeClock,
  BackofficeUnitOfWork,
  ParameterDefaults,
  ParameterRepository,
} from '../ports/backoffice-ports.js';

export type BackofficeActor = { readonly sub: string; readonly role: string };

const STAFF_ROLES: readonly string[] = ['operator', 'finance', 'admin'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CURSOR_LENGTH = 200;

export interface ParameterView extends ParameterDefinition {
  readonly value: bigint;
  readonly defaultValue: bigint;
  readonly updatedBy: string | null;
  readonly updatedAt: Date | null;
}

export class BackofficeService {
  constructor(
    private readonly parameters: ParameterRepository,
    private readonly auditQueries: AuditQueryRepository,
    private readonly audit: AuditWriter,
    private readonly defaults: ParameterDefaults,
    private readonly uow: BackofficeUnitOfWork,
    private readonly clock: BackofficeClock,
    private readonly metricsSources: MetricsSourcesPort,
  ) {}

  /** Operational aggregates; staff only, no personal data. */
  async metrics(
    actor: BackofficeActor,
  ): Promise<BackofficeMetrics & { readonly generatedAt: Date }> {
    this.requireRole(actor, STAFF_ROLES);
    return { ...(await this.metricsSources.collect()), generatedAt: this.clock.now() };
  }

  /** Every parameter with its current value; staff only. */
  async listParameters(actor: BackofficeActor): Promise<readonly ParameterView[]> {
    this.requireRole(actor, STAFF_ROLES);
    const stored = new Map((await this.parameters.findAll()).map((p) => [p.key, p]));
    return PARAMETER_KEYS.map((key) => this.view(key, stored.get(key) ?? null));
  }

  /** Admin only; forward only (affects what happens from now on) and audited. */
  async updateParameter(
    actor: BackofficeActor,
    rawKey: string,
    rawValue: string,
  ): Promise<ParameterView> {
    this.requireRole(actor, ['admin']);
    if (!isParameterKey(rawKey)) throw new DomainError('Parámetro no encontrado.', 'not_found');
    const value = parseParameterValue(rawKey, rawValue);
    return this.uow.run(async () => {
      const current = await this.parameters.find(rawKey, true);
      const previous = current?.value ?? this.defaults[rawKey];
      const updated = { key: rawKey, value, updatedBy: actor.sub, updatedAt: this.clock.now() };
      await this.parameters.upsert(updated);
      await this.audit.record({
        actorId: actor.sub,
        actorRole: actor.role,
        action: 'parameter.update',
        entity: 'parameter',
        entityId: rawKey,
        before: { value: previous.toString() },
        after: { value: value.toString() },
      });
      return this.view(rawKey, updated);
    });
  }

  /** The audit trail, newest first; admin only. */
  async listAudit(
    actor: BackofficeActor,
    filter: AuditFilter,
    cursor: string | undefined,
    limit: number,
  ): Promise<{ readonly items: readonly AuditRecord[]; readonly nextCursor?: string }> {
    this.requireRole(actor, ['admin']);
    const rows = await this.auditQueries.list(
      filter,
      cursor ? this.decodeCursor(cursor) : null,
      limit + 1,
    );
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return rows.length > limit && last
      ? {
          items,
          nextCursor: Buffer.from(`${last.at.toISOString()}|${last.id}`).toString('base64url'),
        }
      : { items };
  }

  private view(
    key: ParameterKey,
    stored: { readonly value: bigint; readonly updatedBy: string; readonly updatedAt: Date } | null,
  ): ParameterView {
    return {
      ...PARAMETER_DEFINITIONS[key],
      value: stored?.value ?? this.defaults[key],
      defaultValue: this.defaults[key],
      updatedBy: stored?.updatedBy ?? null,
      updatedAt: stored?.updatedAt ?? null,
    };
  }

  private requireRole(actor: BackofficeActor, roles: readonly string[]): void {
    if (!roles.includes(actor.role)) throw new DomainError('Rol no autorizado.', 'forbidden');
  }

  private decodeCursor(cursor: string): { readonly at: Date; readonly id: string } {
    const invalid = () => new DomainError('Cursor inválido.', 'invalid_cursor');
    if (cursor.length > MAX_CURSOR_LENGTH) throw invalid();
    const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    const date = new Date(at ?? '');
    if (!id || !UUID.test(id) || Number.isNaN(date.getTime())) throw invalid();
    return { at: date, id };
  }
}
