import { SyncOperationHandlerRegistry } from './sync-operation-handler-registry.js';
import { SyncService } from './sync-service.js';
import type { ProcessedOperation, SyncRepositoryPort } from '../ports/sync-ports.js';
import type { SyncOperationContract } from '@tracop/contracts';
import { DomainError } from '../../../shared/kernel/domain-error.js';

describe('SyncService', () => {
  const actor = { sub: '0190f47a-8b45-7cc2-9a1e-123456789abd', role: 'producer', did: 'device-a' };
  const opId = '0190f47a-8b45-7cc2-9a1e-123456789abc';
  const entityId = '0190f47a-8b45-7cc2-9a1e-123456789abe';
  const operation: SyncOperationContract = {
    opId,
    entity: 'lot',
    entityId,
    type: 'create',
    payload: { id: entityId },
  };

  const setup = () => {
    const processed = new Map<string, ProcessedOperation>();
    const changes = new Map<string, string>();
    const repository: SyncRepositoryPort = {
      acquireOperationLock: async () => undefined,
      findProcessed: async (id) => processed.get(id) ?? null,
      saveProcessed: async (value) => {
        processed.set(value.opId, value);
      },
      appendChange: async (change) => {
        const seq = String(changes.size + 1);
        changes.set(`${change.entity}:${change.entityId}:${change.ownerUserId}`, seq);
        return seq;
      },
      appendBaselineIfAbsent: async () => null,
      pull: async ({ cursor }) => ({ changes: [], nextCursor: cursor, hasMore: false }),
    };
    const registry = new SyncOperationHandlerRegistry();
    let calls = 0;
    registry.register({
      entity: 'lot',
      handle: async (_user, input) => {
        if (input.type === 'update')
          throw new DomainError('No debe actualizar.', 'invalid_payload');
        calls += 1;
        await repository.appendChange({
          entity: 'lot',
          entityId: input.entityId,
          op: input.type,
          payload: input.payload,
          ownerUserId: actor.sub,
          occurredAt: new Date('2025-01-01T00:00:00Z'),
        });
        return { serverVersion: calls };
      },
    });
    const service = new SyncService(
      repository,
      { run: (fn) => fn() },
      { consume: () => undefined },
      registry,
    );
    return { service, processed, calls: () => calls };
  };

  it('replays the same result idempotently and rejects a reused opId with different content', async () => {
    const { service, calls } = setup();
    const first = await service.push(actor, [operation]);
    const replay = await service.push(actor, [operation]);
    const reused = await service.push(actor, [
      { ...operation, payload: { id: entityId, name: 'different' } },
    ]);
    expect(replay).toEqual(first);
    expect(reused.results[0]).toMatchObject({ status: 'rejected', code: 'op_id_reused' });
    expect(calls()).toBe(1);
  });

  it('does not reveal another user’s stored idempotency result', async () => {
    const { service } = setup();
    await service.push(actor, [operation]);
    const other = await service.push({ ...actor, sub: '0190f47a-8b45-7cc2-9a1e-123456789abf' }, [
      operation,
    ]);
    expect(other.results[0]).toEqual({ opId, status: 'rejected' });
  });

  it('marks later operations for a failed entity as dependency_failed', async () => {
    const { service } = setup();
    const output = await service.push(actor, [
      { ...operation, type: 'update', baseVersion: 1 },
      {
        ...operation,
        opId: '0190f47a-8b45-7cc2-9a1e-123456789ab1',
        type: 'update',
        baseVersion: 1,
      },
    ]);
    expect(output.results.map((result) => result.code)).toEqual([
      'invalid_payload',
      'dependency_failed',
    ]);
  });

  it('registers and retrieves a handler and rejects duplicate entity handlers', () => {
    const registry = new SyncOperationHandlerRegistry();
    const handler = { entity: 'lot', handle: async () => ({ serverVersion: 1 }) };
    registry.register(handler);
    expect(registry.get('lot')).toBe(handler);
    expect(registry.get('unknown')).toBeUndefined();
    expect(() => registry.register(handler)).toThrow('Duplicate sync handler: lot');
  });
});
