import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { SyncOperationContract } from '@tracop/contracts';
import { DomainError } from '../../../shared/kernel/domain-error.js';
import { SyncOperationHandlerRegistry } from './sync-operation-handler-registry.js';
import {
  SYNC_RATE_LIMIT,
  SYNC_REPOSITORY,
  SYNC_UNIT_OF_WORK,
  type ProcessedOperation,
  type SyncOperationResult,
  type SyncRateLimitPort,
  type SyncRepositoryPort,
  type SyncUnitOfWorkPort,
} from '../ports/sync-ports.js';

export type SyncActor = { readonly sub: string; readonly role: string; readonly did: string };

@Injectable()
export class SyncService {
  constructor(
    @Inject(SYNC_REPOSITORY) private readonly repository: SyncRepositoryPort,
    @Inject(SYNC_UNIT_OF_WORK) private readonly uow: SyncUnitOfWorkPort,
    @Inject(SYNC_RATE_LIMIT) private readonly rateLimit: SyncRateLimitPort,
    @Inject(SyncOperationHandlerRegistry) private readonly handlers: SyncOperationHandlerRegistry,
  ) {}

  async push(actor: SyncActor, operations: readonly SyncOperationContract[]) {
    this.rateLimit.consume(actor.sub, 'push');
    const results: SyncOperationResult[] = [];
    const failedEntities = new Set<string>();

    for (const operation of operations) {
      const result = await this.processOperation(actor, operation, failedEntities);
      results.push(result);
      if (result.status !== 'applied')
        failedEntities.add(`${operation.entity}:${operation.entityId}`);
    }
    return { results };
  }

  async pull(actor: SyncActor, cursor: string, limit: number) {
    this.rateLimit.consume(actor.sub, 'pull');
    return this.repository.pull({ userId: actor.sub, cursor, limit });
  }

  private processOperation(
    actor: SyncActor,
    operation: SyncOperationContract,
    failedEntities: ReadonlySet<string>,
  ): Promise<SyncOperationResult> {
    return this.uow.run(async () => {
      await this.repository.acquireOperationLock(operation.opId);
      const payloadHash = createHash('sha256').update(canonicalJson(operation)).digest('hex');
      const previous = await this.repository.findProcessed(operation.opId);
      if (previous) {
        if (previous.userId !== actor.sub) return { opId: operation.opId, status: 'rejected' };
        if (previous.payloadHash !== payloadHash) {
          return { opId: operation.opId, status: 'rejected', code: 'op_id_reused' };
        }
        return previous.result;
      }

      const dependencyKey = `${operation.entity}:${operation.entityId}`;
      const handler = this.handlers.get(operation.entity);
      let result: SyncOperationResult;
      if (failedEntities.has(dependencyKey)) {
        result = { opId: operation.opId, status: 'rejected', code: 'dependency_failed' };
      } else if (!handler) {
        result = { opId: operation.opId, status: 'rejected', code: 'unknown_entity' };
      } else {
        try {
          const applied = await this.uow.run(() => handler.handle(actor, operation));
          result = {
            opId: operation.opId,
            status: 'applied',
            serverVersion: applied.serverVersion,
          };
        } catch (error) {
          result = mapFailure(operation.opId, error);
        }
      }

      const processed: ProcessedOperation = {
        opId: operation.opId,
        deviceId: actor.did,
        userId: actor.sub,
        entity: operation.entity,
        entityId: operation.entityId,
        result,
        errorCode: result.code ?? null,
        payloadHash,
        serverSeq: result.serverSeq ?? null,
      };
      await this.repository.saveProcessed(processed);
      return result;
    });
  }
}

const mapFailure = (opId: string, error: unknown): SyncOperationResult => {
  const code = error instanceof DomainError ? error.code : 'invalid_payload';
  if (code === 'version_conflict') {
    return {
      opId,
      status: 'conflict',
      code: 'version_conflict',
      ...(isServerVersionError(error) ? { serverVersion: error.serverVersion } : {}),
    };
  }
  const supportedCodes = new Set([
    'invalid_payload',
    'unknown_entity',
    'not_found',
    'forbidden',
    'version_conflict',
    'invalid_transition',
    'unsupported_transition',
    'dependency_failed',
    'op_id_reused',
  ]);
  const normalized = supportedCodes.has(code)
    ? code
    : code === 'invalid_transition'
      ? code
      : 'invalid_payload';
  return { opId, status: 'rejected', code: normalized };
};

const isServerVersionError = (error: unknown): error is DomainError & { serverVersion: number } =>
  error instanceof DomainError &&
  'serverVersion' in error &&
  typeof error.serverVersion === 'number';

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort((left, right) => left.localeCompare(right))
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
};
