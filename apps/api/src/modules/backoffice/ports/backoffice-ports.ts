import type { ParameterKey } from '../../../shared/kernel/parameter-keys.js';

export interface StoredParameter {
  readonly key: ParameterKey;
  readonly value: bigint;
  readonly updatedBy: string;
  readonly updatedAt: Date;
}

export interface AuditRecord {
  readonly id: string;
  readonly actorId: string | null;
  readonly actorRole: string;
  readonly action: string;
  readonly entity: string;
  readonly entityId: string;
  readonly before: Readonly<Record<string, unknown>> | null;
  readonly after: Readonly<Record<string, unknown>> | null;
  readonly at: Date;
}

export interface AuditFilter {
  readonly entity?: string | undefined;
  readonly entityId?: string | undefined;
  readonly actorId?: string | undefined;
  readonly action?: string | undefined;
}

export interface ParameterRepository {
  find(key: ParameterKey, lock?: boolean): Promise<StoredParameter | null>;
  findAll(): Promise<readonly StoredParameter[]>;
  upsert(parameter: StoredParameter): Promise<void>;
}

export interface AuditQueryRepository {
  list(
    filter: AuditFilter,
    cursor: { readonly at: Date; readonly id: string } | null,
    limit: number,
  ): Promise<readonly AuditRecord[]>;
}

export interface BackofficeUnitOfWork {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

export interface BackofficeClock {
  now(): Date;
}

/** The environment value of each parameter, used while the staff has not stored one. */
export type ParameterDefaults = Readonly<Record<ParameterKey, bigint>>;

export const PARAMETER_REPOSITORY = Symbol('PARAMETER_REPOSITORY');
export const AUDIT_QUERY_REPOSITORY = Symbol('AUDIT_QUERY_REPOSITORY');
export const PARAMETER_DEFAULTS = Symbol('PARAMETER_DEFAULTS');

/** Aggregates from every module, read through their public queries (no cross-schema joins). */
export interface BackofficeMetrics {
  readonly ordersByStatus: Readonly<Record<string, number>>;
  readonly paidOrdersTotalCop: bigint;
  readonly lotsByStatus: Readonly<Record<string, number>>;
  readonly payments: {
    readonly proofsAwaitingReview: number;
    readonly oldestProofUploadedAt: Date | null;
    readonly openDisputes: number;
    readonly settlementsIssued: { readonly count: number; readonly amountCop: bigint };
    readonly settlementsPaid: { readonly count: number; readonly amountCop: bigint };
  };
  readonly notificationDeliveries: Readonly<Record<string, number>>;
  readonly outbox: { readonly pending: number; readonly deadLettered: number };
}

export interface MetricsSourcesPort {
  collect(): Promise<BackofficeMetrics>;
}

export const METRICS_SOURCES_PORT = Symbol('METRICS_SOURCES_PORT');
