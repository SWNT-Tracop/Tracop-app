import { DomainError } from '../../../shared/kernel/domain-error.js';
import type { PaymentProps } from './payment.js';

export type SettlementBeneficiary = 'producer' | 'carrier';
export type SettlementStatus = 'issued' | 'paid';

export interface SettlementProps {
  readonly id: string;
  readonly paymentId: string;
  readonly orderId: string;
  readonly beneficiaryId: string;
  readonly beneficiaryKind: SettlementBeneficiary;
  readonly amount: bigint;
  readonly status: SettlementStatus;
  readonly issuedAt: Date;
  readonly paidAt: Date | null;
  readonly paidBy: string | null;
  readonly reference: string | null;
  readonly version: number;
}

const MAX_REFERENCE_LENGTH = 100;

/** What each beneficiary is owed once a held payment's claim window is over. */
export const planSettlements = (
  payment: PaymentProps,
  createId: () => string,
  now: Date,
): readonly SettlementProps[] => {
  if (payment.status !== 'held')
    throw new DomainError('Solo se liquida un pago retenido.', 'invalid_transition');
  const plan: SettlementProps[] = [];
  const issue = (beneficiaryKind: SettlementBeneficiary, beneficiaryId: string, amount: bigint) =>
    plan.push({
      id: createId(),
      paymentId: payment.id,
      orderId: payment.orderId,
      beneficiaryId,
      beneficiaryKind,
      amount,
      status: 'issued',
      issuedAt: now,
      paidAt: null,
      paidBy: null,
      reference: null,
      version: 1,
    });
  if (payment.providerNet > 0n) issue('producer', payment.providerId, payment.providerNet);
  if (payment.freight > 0n) {
    if (!payment.carrierId)
      throw new DomainError('El flete requiere un transportista.', 'carrier_unknown');
    issue('carrier', payment.carrierId, payment.freight);
  }
  return plan;
};

export const markSettlementPaid = (
  settlement: SettlementProps,
  paidBy: string,
  reference: string | null,
  now: Date,
): SettlementProps => {
  if (settlement.status !== 'issued')
    throw new DomainError('La liquidación ya fue pagada.', 'invalid_transition');
  const trimmed = reference?.trim() || null;
  if (trimmed && trimmed.length > MAX_REFERENCE_LENGTH)
    throw new DomainError('La referencia supera 100 caracteres.', 'invalid_reference');
  return {
    ...settlement,
    status: 'paid',
    paidAt: now,
    paidBy,
    reference: trimmed,
    version: settlement.version + 1,
  };
};
