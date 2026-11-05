import type { SyncOperationContract } from '@tracop/contracts';

export type SyncOutcome = 'applied' | 'rejected' | 'conflict';
export type SyncOperationResult = {
  readonly opId: string;
  readonly status: SyncOutcome;
  readonly code?: string;
  readonly serverVersion?: number;
  readonly serverSeq?: string;
};

export type ChangeRecord = {
  readonly entity: string;
  readonly entityId: string;
  readonly op: string;
  readonly payload: Record<string, unknown>;
  readonly ownerUserId: string | null;
  readonly occurredAt: Date;
};

export interface SyncOperationHandlerPort {
  readonly entity: string;
  handle(
    user: { readonly sub: string; readonly role: string },
    operation: SyncOperationContract,
  ): Promise<{ readonly serverVersion: number }>;
}

export type ProcessedOperation = {
  readonly opId: string;
  readonly deviceId: string;
  readonly userId: string;
  readonly entity: string;
  readonly entityId: string;
  readonly result: SyncOperationResult;
  readonly errorCode: string | null;
  readonly payloadHash: string;
  readonly serverSeq: string | null;
};

export interface SyncRepositoryPort {
  acquireOperationLock(opId: string): Promise<void>;
  findProcessed(opId: string): Promise<ProcessedOperation | null>;
  saveProcessed(operation: ProcessedOperation): Promise<void>;
  appendChange(change: ChangeRecord): Promise<string>;
  appendBaselineIfAbsent(change: ChangeRecord): Promise<string | null>;
  hasEntityHistory(entity: string, entityId: string): Promise<boolean>;
  pull(input: {
    readonly userId: string;
    readonly cursor: string;
    readonly limit: number;
  }): Promise<{
    readonly changes: readonly {
      serverSeq: string;
      entity: string;
      entityId: string;
      op: string;
      payload: Record<string, unknown>;
      occurredAt: Date;
    }[];
    readonly nextCursor: string;
    readonly hasMore: boolean;
  }>;
}

export interface SyncUnitOfWorkPort {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

export interface SyncRateLimitPort {
  consume(userId: string, action: 'push' | 'pull'): void;
}

export const SYNC_REPOSITORY = Symbol('SYNC_REPOSITORY');
export const SYNC_UNIT_OF_WORK = Symbol('SYNC_UNIT_OF_WORK');
export const SYNC_RATE_LIMIT = Symbol('SYNC_RATE_LIMIT');
