import type { ParameterKey } from '../../../shared/kernel/parameter-keys.js';
import type { AuditEntryInput } from '../../../shared/ports/audit-writer.js';
import type {
  AuditRecord,
  BackofficeMetrics,
  ParameterDefaults,
  StoredParameter,
} from '../ports/backoffice-ports.js';
import { BackofficeService } from './backoffice-service.js';

const now = new Date('2026-11-25T15:00:00.000Z');
const admin = { sub: '018f47a2-8b45-7cc2-9a1e-00000000000a', role: 'admin' };
const defaults: ParameterDefaults = {
  'order.commission_rate_bps': 0n,
  'order.freight_cop': 0n,
  'order.quote_ttl_hours': 24n,
  'order.reservation_ttl_hours': 24n,
  'payment.claim_window_hours': 48n,
  'payment.rejection_grace_hours': 4n,
  'catalog.product_proposal_pending_limit': 5n,
  'trust.rating_window_days': 7n,
  'trust.min_ratings_visible': 3n,
  'trust.comment_max_length': 500n,
  'trust.verification_cooldown_days': 7n,
};

const metrics: BackofficeMetrics = {
  ordersByStatus: { quoted: 2 },
  paidOrdersTotalCop: 9000n,
  lotsByStatus: { published: 1 },
  payments: {
    proofsAwaitingReview: 1,
    oldestProofUploadedAt: now,
    openDisputes: 0,
    settlementsIssued: { count: 0, amountCop: 0n },
    settlementsPaid: { count: 0, amountCop: 0n },
  },
  notificationDeliveries: { failed: 0 },
  outbox: { pending: 3, deadLettered: 0 },
};

const harness = (records: AuditRecord[] = []) => {
  const stored = new Map<ParameterKey, StoredParameter>();
  const audited: AuditEntryInput[] = [];
  const service = new BackofficeService(
    {
      find: async (key) => stored.get(key) ?? null,
      findAll: async () => [...stored.values()],
      upsert: async (parameter) => void stored.set(parameter.key, parameter),
    },
    { list: async (_filter, _cursor, limit) => records.slice(0, limit) },
    { record: async (entry) => void audited.push(entry) },
    defaults,
    { run: async (operation) => operation() },
    { now: () => now },
    { collect: async () => metrics },
  );
  return { service, stored, audited };
};

describe('BackofficeService', () => {
  it('lists every parameter with its default to the staff', async () => {
    const h = harness();
    const items = await h.service.listParameters({ sub: 'f', role: 'finance' });
    expect(items).toHaveLength(11);
    expect(items[0]).toMatchObject({
      key: 'order.commission_rate_bps',
      value: 0n,
      defaultValue: 0n,
      updatedAt: null,
    });
    await expect(h.service.listParameters({ sub: 'b', role: 'buyer' })).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('lets only an admin change a parameter, auditing the previous and new value', async () => {
    const h = harness();
    await expect(
      h.service.updateParameter({ sub: 'o', role: 'operator' }, 'order.freight_cop', '10'),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(h.service.updateParameter(admin, 'order.nope', '10')).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      h.service.updateParameter(admin, 'order.commission_rate_bps', '20000'),
    ).rejects.toMatchObject({ code: 'parameter_out_of_range' });

    const first = await h.service.updateParameter(admin, 'order.commission_rate_bps', '500');
    expect(first).toMatchObject({ value: 500n, defaultValue: 0n, updatedBy: admin.sub });
    await h.service.updateParameter(admin, 'order.commission_rate_bps', '750');
    expect(h.audited).toEqual([
      expect.objectContaining({
        action: 'parameter.update',
        entityId: 'order.commission_rate_bps',
        before: { value: '0' },
        after: { value: '500' },
      }),
      expect.objectContaining({ before: { value: '500' }, after: { value: '750' } }),
    ]);
  });

  it('pages the audit log for admins only and rejects a malformed cursor', async () => {
    const record = (id: string): AuditRecord => ({
      id,
      actorId: admin.sub,
      actorRole: 'admin',
      action: 'parameter.update',
      entity: 'parameter',
      entityId: 'order.freight_cop',
      before: null,
      after: null,
      at: now,
    });
    const h = harness([
      record('018f47a2-8b45-7cc2-9a1e-000000000002'),
      record('018f47a2-8b45-7cc2-9a1e-000000000001'),
    ]);
    const first = await h.service.listAudit(admin, {}, undefined, 1);
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect((await h.service.listAudit(admin, {}, first.nextCursor, 5)).items).toHaveLength(2);
    await expect(
      h.service.listAudit({ sub: 'f', role: 'finance' }, {}, undefined, 1),
    ).rejects.toMatchObject({ code: 'forbidden' });
    for (const cursor of ['x'.repeat(201), Buffer.from('bad|id').toString('base64url')])
      await expect(h.service.listAudit(admin, {}, cursor, 1)).rejects.toMatchObject({
        code: 'invalid_cursor',
      });
  });

  it('serves metrics to the staff only, stamped with the time', async () => {
    const h = harness();
    expect(await h.service.metrics({ sub: 'o', role: 'operator' })).toEqual({
      ...metrics,
      generatedAt: now,
    });
    await expect(h.service.metrics({ sub: 's', role: 'supplier' })).rejects.toMatchObject({
      code: 'forbidden',
    });
  });
});
