import { Payment, type PaymentProps } from './payment.js';
import { markSettlementPaid, planSettlements } from './settlement.js';

const now = new Date('2026-11-24T15:00:00.000Z');
let sequence = 0;
const createId = () => `settlement-${(sequence += 1)}`;

const heldPayment = (overrides: Partial<PaymentProps> = {}): PaymentProps => ({
  ...Payment.initiate({
    id: 'payment',
    orderId: 'order',
    buyerId: 'buyer',
    providerId: 'provider',
    method: 'nequi',
    amounts: {
      subtotal: 100_000n,
      freight: 20_000n,
      commission: 5_000n,
      total: 120_000n,
      providerNet: 95_000n,
    },
    now,
  }).props,
  status: 'held',
  heldAt: now,
  carrierId: 'carrier',
  ...overrides,
});

describe('settlements', () => {
  beforeEach(() => {
    sequence = 0;
  });

  it('owes the provider its net and the carrier the freight', () => {
    expect(planSettlements(heldPayment(), createId, now)).toEqual([
      expect.objectContaining({
        id: 'settlement-1',
        beneficiaryKind: 'producer',
        beneficiaryId: 'provider',
        amount: 95_000n,
        status: 'issued',
      }),
      expect.objectContaining({
        id: 'settlement-2',
        beneficiaryKind: 'carrier',
        beneficiaryId: 'carrier',
        amount: 20_000n,
      }),
    ]);
  });

  it('skips the carrier without freight and requires one with it', () => {
    const noFreight = heldPayment({ freight: 0n, total: 100_000n, carrierId: null });
    expect(planSettlements(noFreight, createId, now).map((s) => s.beneficiaryKind)).toEqual([
      'producer',
    ]);
    expect(() => planSettlements(heldPayment({ carrierId: null }), createId, now)).toThrow(
      expect.objectContaining({ code: 'carrier_unknown' }),
    );
  });

  it('only settles a held payment', () => {
    expect(() => planSettlements(heldPayment({ status: 'disputed' }), createId, now)).toThrow(
      expect.objectContaining({ code: 'invalid_transition' }),
    );
  });

  it('marks a settlement paid once, trimming the reference', () => {
    const [issued] = planSettlements(heldPayment(), createId, now);
    const paid = markSettlementPaid(issued!, 'finance', '  TRX-1  ', now);
    expect(paid).toMatchObject({
      status: 'paid',
      paidBy: 'finance',
      reference: 'TRX-1',
      paidAt: now,
      version: 2,
    });
    expect(markSettlementPaid(issued!, 'finance', '   ', now).reference).toBeNull();
    expect(() => markSettlementPaid(paid, 'finance', null, now)).toThrow(
      expect.objectContaining({ code: 'invalid_transition' }),
    );
    expect(() => markSettlementPaid(issued!, 'finance', 'x'.repeat(101), now)).toThrow(
      expect.objectContaining({ code: 'invalid_reference' }),
    );
  });
});
