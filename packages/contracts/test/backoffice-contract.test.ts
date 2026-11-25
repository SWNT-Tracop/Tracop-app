import { describe, expect, it } from 'vitest';
import {
  auditEntryResponseSchema,
  auditQuerySchema,
  updateParameterSchema,
} from '../src/schemas/backoffice.js';

describe('backoffice contracts', () => {
  it('updates a parameter with an integer string only', () => {
    expect(updateParameterSchema.safeParse({ value: '250' }).success).toBe(true);
    for (const value of ['2.5', '', '01', 250, '1e3'])
      expect(updateParameterSchema.safeParse({ value }).success).toBe(false);
  });

  it('filters the audit log strictly and bounds the page', () => {
    expect(auditQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(auditQuerySchema.safeParse({ actorId: 'not-a-uuid' }).success).toBe(false);
    expect(auditQuerySchema.safeParse({ ip: '1.2.3.4' }).success).toBe(false);
  });

  it('never exposes the IP hash or request id in audit entries', () => {
    const entry = {
      id: '018f47a2-8b45-7cc2-9a1e-123456789abc',
      actorId: null,
      actorRole: 'system',
      action: 'staff.create',
      entity: 'user',
      entityId: '018f47a2-8b45-7cc2-9a1e-123456789abd',
      before: null,
      after: { role: 'finance' },
      at: '2026-11-25T15:00:00.000Z',
    };
    expect(auditEntryResponseSchema.safeParse(entry).success).toBe(true);
    expect(auditEntryResponseSchema.safeParse({ ...entry, ipHash: 'a'.repeat(64) }).success).toBe(
      false,
    );
  });
});
