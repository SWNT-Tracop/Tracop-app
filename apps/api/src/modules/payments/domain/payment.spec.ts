import { Payment, type PaymentAmounts, type PaymentStatus } from './payment.js';

const now = new Date('2026-11-24T15:00:00.000Z');
const later = (hours: number) => new Date(now.getTime() + hours * 3_600_000);
const amounts: PaymentAmounts = {
  subtotal: 100_000n,
  freight: 20_000n,
  commission: 5_000n,
  total: 120_000n,
  providerNet: 95_000n,
};

const initiate = (overrides: Partial<PaymentAmounts> = {}) =>
  Payment.initiate({
    id: 'payment',
    orderId: 'order',
    buyerId: 'buyer',
    providerId: 'provider',
    method: 'transfer',
    amounts: { ...amounts, ...overrides },
    now,
  });

const withProof = () => {
  const payment = initiate();
  payment.prepareProofUpload('payment-incoming/payment/a', later(1), now);
  payment.confirmProof('payment-proofs/payment/b.webp', now);
  return payment;
};

describe('Payment', () => {
  it('starts pending with the quote amounts and records who initiated it', () => {
    const payment = initiate();
    expect(payment.props).toMatchObject({ status: 'pending', version: 1, total: 120_000n });
    expect(payment.drainEvents()).toEqual([
      expect.objectContaining({
        type: 'PaymentInitiated',
        actorId: 'buyer',
        payload: { status: 'pending', method: 'transfer', total: '120000' },
      }),
    ]);
  });

  it.each([
    ['a negative amount', { freight: -1n, total: 99_999n }],
    ['a zero total', { subtotal: 0n, freight: 0n, commission: 0n, total: 0n, providerNet: 0n }],
    ['a total that is not subtotal + freight', { total: 1n }],
    ['a net that is not subtotal - commission', { providerNet: 1n }],
  ])('rejects %s', (_label, overrides) => {
    expect(() => initiate(overrides)).toThrow(expect.objectContaining({ code: 'invalid_amounts' }));
  });

  it('rejects an unsupported method', () => {
    expect(() =>
      Payment.initiate({
        id: 'payment',
        orderId: 'order',
        buyerId: 'buyer',
        providerId: 'provider',
        method: 'cash' as never,
        amounts,
        now,
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_payment_method' }));
  });

  it('needs a prepared upload before the proof is confirmed', () => {
    const payment = initiate();
    expect(() => payment.confirmProof('key', now)).toThrow(
      expect.objectContaining({ code: 'proof_upload_missing' }),
    );
    payment.prepareProofUpload('payment-incoming/payment/a', later(1), now);
    payment.confirmProof('payment-proofs/payment/b.webp', now);
    expect(payment.props).toMatchObject({
      status: 'proof_uploaded',
      proofKey: 'payment-proofs/payment/b.webp',
      proofIncomingKey: null,
      proofUploadedAt: now,
    });
    expect(() => payment.prepareProofUpload('again', later(1), now)).toThrow(
      expect.objectContaining({ code: 'invalid_transition' }),
    );
  });

  it('verifies or rejects a proof once, keeping the reviewer and the reason', () => {
    const verified = withProof();
    verified.verify('finance', now);
    expect(verified.props).toMatchObject({ status: 'verified', reviewedBy: 'finance' });
    expect(() => verified.verify('finance', now)).toThrow(
      expect.objectContaining({ code: 'invalid_transition' }),
    );
    expect(() => verified.reject('finance', 'tarde', now)).toThrow(
      expect.objectContaining({ code: 'invalid_transition' }),
    );

    const rejected = withProof();
    expect(() => rejected.reject('finance', '   ', now)).toThrow(
      expect.objectContaining({ code: 'rejection_reason_required' }),
    );
    rejected.reject('finance', '  Comprobante ilegible  ', now);
    expect(rejected.props).toMatchObject({
      status: 'rejected',
      rejectionReason: 'Comprobante ilegible',
    });
  });

  it('holds after delivery, requiring a carrier when there is freight', () => {
    const payment = withProof();
    payment.verify('finance', now);
    expect(() => payment.hold(null, now)).toThrow(
      expect.objectContaining({ code: 'carrier_unknown' }),
    );
    payment.hold('carrier', later(2));
    expect(payment.props).toMatchObject({ status: 'held', heldAt: later(2), carrierId: 'carrier' });

    const noFreight = initiate({ freight: 0n, total: 100_000n });
    noFreight.prepareProofUpload('k', later(1), now);
    noFreight.confirmProof('p', now);
    noFreight.verify('finance', now);
    noFreight.hold(null, now);
    expect(noFreight.props.status).toBe('held');
  });

  it('knows when the claim window is over, only while held', () => {
    const payment = withProof();
    payment.verify('finance', now);
    expect(payment.isClaimWindowOver(later(100), 48)).toBe(false);
    payment.hold('carrier', now);
    expect(payment.isClaimWindowOver(later(47.99), 48)).toBe(false);
    expect(payment.isClaimWindowOver(later(48), 48)).toBe(true);
    payment.dispute('buyer', 'Llegó incompleto', later(1));
    expect(payment.isClaimWindowOver(later(100), 48)).toBe(false);
  });

  it('disputes a verified or held payment and resolves it released or refunded', () => {
    const beforeDelivery = withProof();
    beforeDelivery.verify('finance', now);
    beforeDelivery.dispute('buyer', 'No llegó', now);
    expect(() => beforeDelivery.releaseDispute('operator', 'ok', now)).toThrow(
      expect.objectContaining({ code: 'dispute_not_releasable' }),
    );
    beforeDelivery.refund('operator', 'Se devuelve el dinero', now);
    expect(beforeDelivery.props.status).toBe('refunded');

    const afterDelivery = withProof();
    afterDelivery.verify('finance', now);
    afterDelivery.hold('carrier', now);
    expect(() => afterDelivery.dispute('buyer', '', now)).toThrow(
      expect.objectContaining({ code: 'dispute_reason_required' }),
    );
    afterDelivery.dispute('buyer', 'Calidad distinta', now);
    expect(() => afterDelivery.releaseDispute('operator', ' ', now)).toThrow(
      expect.objectContaining({ code: 'resolution_note_required' }),
    );
    afterDelivery.releaseDispute('operator', 'Se verificó la calidad', now);
    expect(afterDelivery.props.status).toBe('held');
    afterDelivery.settle(now);
    expect(afterDelivery.props.status).toBe('settled');
  });

  it.each<[PaymentStatus, string]>([
    ['pending', 'verify'],
    ['pending', 'dispute'],
    ['rejected', 'verify'],
    ['settled', 'dispute'],
    ['refunded', 'settle'],
  ])('rejects an invalid transition from %s (%s)', (status, action) => {
    const payment = Payment.reconstitute({ ...initiate().props, status, heldAt: now });
    const run: Record<string, () => void> = {
      verify: () => payment.verify('finance', now),
      dispute: () => payment.dispute('buyer', 'motivo', now),
      settle: () => payment.settle(now),
    };
    expect(run[action]).toThrow(expect.objectContaining({ code: 'invalid_transition' }));
  });

  it('records one event per transition with the actor and an increasing version', () => {
    const payment = withProof();
    payment.verify('finance', now);
    payment.hold('carrier', now);
    payment.settle(now);
    expect(payment.drainEvents().map(({ type, actorId }) => [type, actorId])).toEqual([
      ['PaymentInitiated', 'buyer'],
      ['PaymentProofUploaded', 'buyer'],
      ['PaymentVerified', 'finance'],
      ['PaymentHeld', null],
      ['PaymentSettled', null],
    ]);
    expect(payment.props.version).toBe(6);
  });
});
