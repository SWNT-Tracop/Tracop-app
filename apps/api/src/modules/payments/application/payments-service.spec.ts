import type { PaymentProps } from '../domain/payment.js';
import type { SettlementProps } from '../domain/settlement.js';
import type {
  LedgerRepository,
  PaymentOrderPort,
  PaymentRepository,
  PaymentsSettings,
  SettlementRepository,
} from '../ports/payments-ports.js';
import { PaymentsService } from './payments-service.js';

const now = new Date('2026-11-24T15:00:00.000Z');
const buyer = { sub: 'buyer', role: 'buyer' };
const finance = { sub: 'finance', role: 'finance' };
const orderId = '018f47a2-8b45-7cc2-9a1e-123456789abc';
const paymentId = '018f47a2-8b45-7cc2-9a1e-123456789abd';

const settings: PaymentsSettings = {
  proofMaxBytes: 100,
  proofUploadUrlTtlSeconds: 900,
  proofDownloadUrlTtlSeconds: 300,
  image: { maxInputPixels: 1000, maxInputDimension: 100, maxOutputDimension: 50, quality: 80 },
};

const harness = (amounts = { subtotal: 1000n, freight: 0n, commission: 0n }) => {
  const payments = new Map<string, PaymentProps>();
  const settlements = new Map<string, SettlementProps>();
  const posted: string[] = [];
  const objects = new Map<string, Uint8Array>();
  const audited: { action: string; entityId: string }[] = [];
  const paymentRepository: PaymentRepository = {
    findById: async (id) => payments.get(id) ?? null,
    findOpenByOrder: async (id) =>
      [...payments.values()].find((p) => p.orderId === id && p.status !== 'rejected') ?? null,
    findLatestByOrder: async (id) =>
      [...payments.values()].filter((p) => p.orderId === id).at(-1) ?? null,
    insert: async (payment) => {
      payments.set(payment.id, payment);
      return true;
    },
    update: async (payment, expected) => {
      if (payments.get(payment.id)?.version !== expected) return false;
      payments.set(payment.id, payment);
      return true;
    },
    listByStatus: async (statuses) =>
      [...payments.values()].filter((p) => statuses.includes(p.status)),
    findDueForSettlement: async () =>
      [...payments.values()].filter((p) => p.status === 'held').map((p) => p.id),
    appendEvents: async () => undefined,
  };
  const ledger: LedgerRepository = {
    post: async (_order, _payment, transaction) => {
      if (posted.includes(transaction.kind)) return false;
      posted.push(transaction.kind);
      return true;
    },
    listForOrder: async () => [],
  };
  const settlementRepository: SettlementRepository = {
    findById: async (id) => settlements.get(id) ?? null,
    listForPayment: async (id) => [...settlements.values()].filter((s) => s.paymentId === id),
    insertPlan: async (plan) => {
      for (const settlement of plan) settlements.set(settlement.id, settlement);
      return true;
    },
    update: async (settlement) => {
      settlements.set(settlement.id, settlement);
      return true;
    },
    list: async (filter) =>
      [...settlements.values()].filter(
        (s) => !filter.beneficiaryId || s.beneficiaryId === filter.beneficiaryId,
      ),
  };
  const total = amounts.subtotal + amounts.freight;
  const orders: jest.Mocked<PaymentOrderPort> = {
    getOrder: jest.fn(async (id: string) =>
      id === orderId
        ? {
            orderId,
            buyerId: 'buyer',
            providerId: 'provider',
            status: 'accepted',
            amounts: { ...amounts, total, providerNet: amounts.subtotal - amounts.commission },
          }
        : null,
    ),
    startPayment: jest.fn<Promise<void>, [string, string]>(async () => undefined),
    holdStockForReview: jest.fn<Promise<void>, [string]>(async () => undefined),
    resumeStockExpiry: jest.fn<Promise<void>, [string, Date]>(async () => undefined),
    markPaid: jest.fn<Promise<void>, [string, string]>(async () => undefined),
    markDisputed: jest.fn<Promise<void>, [string, string]>(async () => undefined),
    close: jest.fn<Promise<void>, [string, string | null]>(async () => undefined),
  };
  const processor = {
    process: jest.fn(async () => ({ bytes: new Uint8Array([1]), width: 1, height: 1 })),
  };
  let sequence = 0;
  const service = new PaymentsService(
    paymentRepository,
    ledger,
    settlementRepository,
    orders,
    { findDeliveringCarrier: async () => 'carrier' },
    {
      createUploadPolicy: async (input) => ({
        url: 'https://storage.invalid',
        fields: { key: input.key },
        expiresAt: input.expiresAt,
      }),
      headObject: async (key) => {
        const bytes = objects.get(key);
        return bytes ? { key, sizeBytes: bytes.byteLength, lastModified: now } : null;
      },
      getObject: async (key) => objects.get(key)!,
      putObject: async (input) => {
        objects.set(input.key, input.body);
      },
      createDownloadUrl: async (key) => `https://storage.invalid/${key}`,
      deleteObject: async (key) => {
        objects.delete(key);
      },
      listObjects: async function* () {},
    },
    processor,
    { append: async () => undefined },
    { run: async (operation) => operation() },
    { now: () => now },
    settings,
    { record: async (entry) => void audited.push(entry) },
    {
      get: async (key) =>
        key === 'payment.claim_window_hours'
          ? 48n
          : key === 'payment.rejection_grace_hours'
            ? 4n
            : 0n,
    },
    () => `settlement-${(sequence += 1)}`,
  );
  const pendingWithUpload = async () => {
    await service.initiate(buyer, { orderId, paymentId, method: 'nequi' });
    const policy = await service.requestProofUpload(buyer, paymentId);
    return policy.fields.key!;
  };
  return {
    service,
    payments,
    settlements,
    posted,
    objects,
    orders,
    processor,
    pendingWithUpload,
    audited,
  };
};

describe('PaymentsService', () => {
  it('only lets buyers pay their own orders, with UUID v7 ids', async () => {
    const h = harness();
    await expect(
      h.service.initiate(finance, { orderId, paymentId, method: 'transfer' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      h.service.initiate(buyer, { orderId, paymentId: 'not-a-v7', method: 'transfer' }),
    ).rejects.toMatchObject({ code: 'invalid_payment_id' });
    await expect(
      h.service.initiate(
        { sub: 'other', role: 'buyer' },
        { orderId, paymentId, method: 'transfer' },
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      h.service.initiate(buyer, {
        orderId: '018f47a2-8b45-7cc2-9a1e-000000000000',
        paymentId,
        method: 'transfer',
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('refuses proofs that are missing, expired, too large or not images', async () => {
    const missing = harness();
    await missing.pendingWithUpload();
    await expect(missing.service.confirmProof(buyer, paymentId)).rejects.toMatchObject({
      code: 'proof_upload_missing',
    });

    const tooLarge = harness();
    const key = await tooLarge.pendingWithUpload();
    tooLarge.objects.set(key, new Uint8Array(101));
    await expect(tooLarge.service.confirmProof(buyer, paymentId)).rejects.toMatchObject({
      code: 'proof_size_invalid',
    });

    const notImage = harness();
    notImage.objects.set(await notImage.pendingWithUpload(), new Uint8Array([1, 2, 3]));
    notImage.processor.process.mockRejectedValueOnce(new Error('unsupported_image_format'));
    await expect(notImage.service.confirmProof(buyer, paymentId)).rejects.toMatchObject({
      code: 'proof_image_invalid',
    });

    const expired = harness();
    await expired.pendingWithUpload();
    expired.payments.set(paymentId, {
      ...expired.payments.get(paymentId)!,
      proofUploadExpiresAt: new Date(now.getTime() - 1),
    });
    await expect(expired.service.confirmProof(buyer, paymentId)).rejects.toMatchObject({
      code: 'proof_expired',
    });

    const notPending = harness();
    await notPending.service.initiate(buyer, { orderId, paymentId, method: 'nequi' });
    await expect(notPending.service.confirmProof(buyer, paymentId)).rejects.toMatchObject({
      code: 'proof_upload_missing',
    });
    await expect(
      notPending.service.confirmProof({ sub: 'other', role: 'buyer' }, paymentId),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('deletes the processed proof when the order can no longer hold its stock', async () => {
    const h = harness();
    h.objects.set(await h.pendingWithUpload(), new Uint8Array([9]));
    h.orders.holdStockForReview.mockRejectedValueOnce(
      Object.assign(new Error('expired'), { code: 'reservation_expired' }),
    );
    await expect(h.service.confirmProof(buyer, paymentId)).rejects.toMatchObject({
      code: 'reservation_expired',
    });
    expect([...h.objects.keys()].filter((key) => key.startsWith('payment-proofs/'))).toEqual([]);
    expect(h.payments.get(paymentId)?.status).toBe('pending');
  });

  it('shows payments to the buyer and staff only, with the proof URL', async () => {
    const h = harness();
    h.objects.set(await h.pendingWithUpload(), new Uint8Array([9]));
    await h.service.confirmProof(buyer, paymentId);
    expect((await h.service.get(finance, paymentId)).proofUrl).toMatch(/^https:/);
    expect((await h.service.getForOrder(buyer, orderId)).payment.id).toBe(paymentId);
    await expect(
      h.service.get({ sub: 'provider', role: 'supplier' }, paymentId),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(h.service.getForOrder(buyer, 'other-order')).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(h.service.listForReview(buyer, 10)).rejects.toMatchObject({ code: 'forbidden' });
    expect((await h.service.listForReview(finance, 10)).map((p) => p.id)).toEqual([paymentId]);
    await expect(h.service.ledgerForOrder(buyer, orderId)).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('settles freight with the delivering carrier and releases a dispute after delivery', async () => {
    const h = harness({ subtotal: 1000n, freight: 200n, commission: 50n });
    h.objects.set(await h.pendingWithUpload(), new Uint8Array([9]));
    const uploaded = await h.service.confirmProof(buyer, paymentId);
    await h.service.verify(finance, paymentId, uploaded.payment.version);
    expect(await h.service.holdForDeliveredOrder(orderId)).toBe(true);
    expect(await h.service.holdForDeliveredOrder(orderId)).toBe(false);
    expect(await h.service.holdForDeliveredOrder('other-order')).toBe(false);

    const held = h.payments.get(paymentId)!;
    const disputed = await h.service.dispute(buyer, paymentId, held.version, 'Calidad distinta');
    const released = await h.service.resolveDispute(finance, paymentId, {
      expectedVersion: disputed.payment.version,
      outcome: 'release',
      note: 'Se verificó la calidad',
    });
    expect(released.payment.status).toBe('held');
    expect(h.orders.close).toHaveBeenCalledWith(orderId, 'finance');

    h.payments.set(paymentId, {
      ...released.payment,
      heldAt: new Date(now.getTime() - 49 * 3_600_000),
    });
    expect(await h.service.issueDueSettlements()).toBe(1);
    const plan = [...h.settlements.values()];
    expect(plan.map((s) => [s.beneficiaryKind, s.beneficiaryId, s.amount])).toEqual([
      ['producer', 'provider', 950n],
      ['carrier', 'carrier', 200n],
    ]);
    for (const settlement of plan)
      await h.service.markSettlementPaid(finance, settlement.id, {
        expectedVersion: settlement.version,
        reference: null,
      });
    expect(h.payments.get(paymentId)?.status).toBe('settled');
    expect(h.posted).toEqual([
      'payment_verified',
      'delivery_confirmed',
      'settlement_paid_producer',
      'settlement_paid_carrier',
    ]);
    expect(h.audited.map(({ action }) => action)).toEqual([
      'payment.verify',
      'payment.dispute_release',
      'settlement.mark_paid',
      'settlement.mark_paid',
    ]);
  });

  it('lists settlements by role and guards settlement payment', async () => {
    const h = harness();
    expect(await h.service.listSettlements(finance, { limit: 10 })).toEqual([]);
    expect(
      await h.service.listSettlements({ sub: 'provider', role: 'producer' }, { limit: 10 }),
    ).toEqual([]);
    await expect(h.service.listSettlements(buyer, { limit: 10 })).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(
      h.service.markSettlementPaid(finance, 'missing', { expectedVersion: 1, reference: null }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
