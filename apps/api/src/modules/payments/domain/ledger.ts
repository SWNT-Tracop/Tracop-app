import { DomainError } from '../../../shared/kernel/domain-error.js';
import { assertConsistentAmounts, type PaymentAmounts } from './payment.js';

export const LEDGER_ACCOUNTS = [
  'cash_held',
  'payable_buyer_funds',
  'payable_producer',
  'payable_carrier',
  'revenue_commission',
] as const;
export type LedgerAccount = (typeof LEDGER_ACCOUNTS)[number];

/** What a ledger transaction records; one transaction per (order, kind) — the idempotency key. */
export const LEDGER_TRANSACTION_KINDS = [
  'payment_verified',
  'delivery_confirmed',
  'settlement_paid_producer',
  'settlement_paid_carrier',
  'refund',
] as const;
export type LedgerTransactionKind = (typeof LEDGER_TRANSACTION_KINDS)[number];

export interface LedgerLine {
  readonly account: LedgerAccount;
  readonly debit: bigint;
  readonly credit: bigint;
}

export interface LedgerTransaction {
  readonly kind: LedgerTransactionKind;
  readonly lines: readonly LedgerLine[];
}

const debit = (account: LedgerAccount, amount: bigint): LedgerLine => ({
  account,
  debit: amount,
  credit: 0n,
});
const credit = (account: LedgerAccount, amount: bigint): LedgerLine => ({
  account,
  debit: 0n,
  credit: amount,
});

/**
 * Every line moves a positive amount on exactly one side and the transaction balances.
 * Zero-amount lines (no freight, no commission) are dropped rather than recorded.
 */
const transaction = (
  kind: LedgerTransactionKind,
  lines: readonly LedgerLine[],
): LedgerTransaction => {
  for (const line of lines)
    if (line.debit < 0n || line.credit < 0n || (line.debit > 0n && line.credit > 0n))
      throw new DomainError('Asiento contable inválido.', 'invalid_ledger_line');
  const recorded = lines.filter((line) => line.debit > 0n || line.credit > 0n);
  const debits = recorded.reduce((sum, line) => sum + line.debit, 0n);
  const credits = recorded.reduce((sum, line) => sum + line.credit, 0n);
  if (recorded.length < 2 || debits !== credits || debits === 0n)
    throw new DomainError('La transacción contable no está balanceada.', 'unbalanced_ledger');
  return { kind, lines: recorded };
};

/** Payment verified: TRACOP holds the buyer's funds. */
export const paymentVerifiedTransaction = (amounts: PaymentAmounts): LedgerTransaction => {
  assertConsistentAmounts(amounts);
  return transaction('payment_verified', [
    debit('cash_held', amounts.total),
    credit('payable_buyer_funds', amounts.total),
  ]);
};

/** Delivery confirmed: the buyer's funds become payable to the producer, carrier and TRACOP. */
export const deliveryConfirmedTransaction = (amounts: PaymentAmounts): LedgerTransaction => {
  assertConsistentAmounts(amounts);
  return transaction('delivery_confirmed', [
    debit('payable_buyer_funds', amounts.total),
    credit('payable_producer', amounts.providerNet),
    credit('payable_carrier', amounts.freight),
    credit('revenue_commission', amounts.commission),
  ]);
};

/** A settlement was paid out of the held cash. */
export const settlementPaidTransaction = (
  beneficiary: 'producer' | 'carrier',
  amount: bigint,
): LedgerTransaction =>
  transaction(beneficiary === 'producer' ? 'settlement_paid_producer' : 'settlement_paid_carrier', [
    debit(beneficiary === 'producer' ? 'payable_producer' : 'payable_carrier', amount),
    credit('cash_held', amount),
  ]);

/**
 * A dispute ended in a refund: reverse whatever is still owed and pay the buyer back from the
 * held cash. Before delivery only the buyer's funds are owed; after it, the payables are.
 */
export const refundTransaction = (
  amounts: PaymentAmounts,
  delivered: boolean,
): LedgerTransaction => {
  assertConsistentAmounts(amounts);
  return transaction(
    'refund',
    delivered
      ? [
          debit('payable_producer', amounts.providerNet),
          debit('payable_carrier', amounts.freight),
          debit('revenue_commission', amounts.commission),
          credit('cash_held', amounts.total),
        ]
      : [debit('payable_buyer_funds', amounts.total), credit('cash_held', amounts.total)],
  );
};
