import { describe, expect, it } from 'vitest';
import {
  initiatePaymentSchema,
  markSettlementPaidSchema,
  paymentResponseSchema,
  rejectPaymentSchema,
  resolveDisputeSchema,
  settlementQuerySchema,
} from '../src/schemas/payments.js';

const id = '018f47a2-8b45-7cc2-9a1e-123456789abc';
const v4 = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';

describe('payments contracts', () => {
  it('initiates with a UUID v7 and a supported method only', () => {
    expect(initiatePaymentSchema.safeParse({ id, method: 'transfer' }).success).toBe(true);
    expect(initiatePaymentSchema.safeParse({ id, method: 'nequi' }).success).toBe(true);
    expect(initiatePaymentSchema.safeParse({ id, method: 'cash' }).success).toBe(false);
    expect(initiatePaymentSchema.safeParse({ id: v4, method: 'transfer' }).success).toBe(false);
    expect(initiatePaymentSchema.safeParse({ id, method: 'transfer', extra: 1 }).success).toBe(
      false,
    );
  });

  it('requires a trimmed, bounded reason to reject', () => {
    expect(rejectPaymentSchema.safeParse({ expectedVersion: 2, reason: 'Ilegible' }).success).toBe(
      true,
    );
    expect(rejectPaymentSchema.safeParse({ expectedVersion: 2, reason: '   ' }).success).toBe(
      false,
    );
    expect(
      rejectPaymentSchema.safeParse({ expectedVersion: 2, reason: 'x'.repeat(501) }).success,
    ).toBe(false);
    expect(rejectPaymentSchema.safeParse({ expectedVersion: 0, reason: 'x' }).success).toBe(false);
  });

  it('resolves a dispute only as release or refund', () => {
    const input = { expectedVersion: 3, outcome: 'refund', note: 'Se devuelve' };
    expect(resolveDisputeSchema.safeParse(input).success).toBe(true);
    expect(resolveDisputeSchema.safeParse({ ...input, outcome: 'cancel' }).success).toBe(false);
  });

  it('accepts an optional settlement reference up to 100 characters', () => {
    expect(markSettlementPaidSchema.safeParse({ expectedVersion: 1 }).success).toBe(true);
    expect(
      markSettlementPaidSchema.safeParse({ expectedVersion: 1, reference: 'x'.repeat(101) })
        .success,
    ).toBe(false);
    expect(settlementQuerySchema.parse({})).toEqual({ limit: 50 });
  });

  it('describes money as integer strings and never exposes object keys', () => {
    const response = {
      id,
      orderId: id,
      method: 'transfer',
      status: 'proof_uploaded',
      version: 3,
      subtotal: '100000',
      freight: '0',
      commission: '0',
      total: '100000',
      providerNet: '100000',
      proofUploadedAt: '2026-11-24T15:00:00.000Z',
      proofUrl: 'https://storage.example/proof',
      reviewedAt: null,
      rejectionReason: null,
      heldAt: null,
      disputeReason: null,
      createdAt: '2026-11-24T15:00:00.000Z',
      updatedAt: '2026-11-24T15:00:00.000Z',
    };
    expect(paymentResponseSchema.safeParse(response).success).toBe(true);
    expect(paymentResponseSchema.safeParse({ ...response, total: '100000.5' }).success).toBe(false);
    expect(
      paymentResponseSchema.safeParse({ ...response, proofKey: 'payment-proofs/x' }).success,
    ).toBe(false);
  });
});
