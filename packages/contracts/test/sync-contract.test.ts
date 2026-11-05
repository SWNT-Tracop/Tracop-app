import { describe, expect, it } from 'vitest';
import { syncOperationSchema, syncPullQuerySchema, syncPushSchema } from '../src/schemas/sync.js';

const operation = {
  opId: '0190f47a-8b45-7cc2-9a1e-123456789abc',
  entity: 'lot',
  entityId: '0190f47a-8b45-7cc2-9a1e-123456789abd',
  type: 'update',
  payload: { version: 2 },
  baseVersion: 2,
};

describe('sync contracts', () => {
  it('accepts UUID v7 operation ids and rejects another UUID version', () => {
    expect(syncOperationSchema.safeParse(operation).success).toBe(true);
    expect(
      syncOperationSchema.safeParse({ ...operation, opId: '0190f47a-8b45-4cc2-9a1e-123456789abc' })
        .success,
    ).toBe(false);
  });

  it('accepts batches of up to 50 operations', () => {
    expect(
      syncPushSchema.safeParse({ operations: Array.from({ length: 50 }, () => operation) }).success,
    ).toBe(true);
    expect(
      syncPushSchema.safeParse({ operations: Array.from({ length: 51 }, () => operation) }).success,
    ).toBe(false);
  });

  it('accepts 50 payload-heavy operations within the proposed 256 KiB request cap', () => {
    const operations = Array.from({ length: 50 }, (_, index) => ({
      ...operation,
      opId: `0190f47a-8b45-7cc2-9a1e-${String(index).padStart(12, '0')}`,
      payload: { draft: 'x'.repeat(4_000) },
    }));
    const body = JSON.stringify({ operations });
    expect(Buffer.byteLength(body)).toBeLessThan(256 * 1024);
    expect(syncPushSchema.safeParse(JSON.parse(body)).success).toBe(true);
  });

  it('defaults pull cursor and limits while rejecting malformed cursors', () => {
    expect(syncPullQuerySchema.parse({})).toEqual({ cursor: '0', limit: 200 });
    expect(syncPullQuerySchema.safeParse({ cursor: '-1' }).success).toBe(false);
  });
});
