import {
  deliveryConfirmedTransaction,
  paymentVerifiedTransaction,
  refundTransaction,
  settlementPaidTransaction,
  type LedgerTransaction,
} from './ledger.js';
import type { PaymentAmounts } from './payment.js';

const amounts: PaymentAmounts = {
  subtotal: 100_000n,
  freight: 20_000n,
  commission: 5_000n,
  total: 120_000n,
  providerNet: 95_000n,
};

const balance = (transactions: readonly LedgerTransaction[]) => {
  const byAccount = new Map<string, bigint>();
  for (const { lines } of transactions)
    for (const line of lines)
      byAccount.set(line.account, (byAccount.get(line.account) ?? 0n) + line.debit - line.credit);
  return Object.fromEntries([...byAccount].filter(([, value]) => value !== 0n));
};

const isBalanced = ({ lines }: LedgerTransaction) =>
  lines.reduce((sum, line) => sum + line.debit, 0n) ===
  lines.reduce((sum, line) => sum + line.credit, 0n);

describe('ledger', () => {
  it('balances every transaction of a paid, delivered and settled order', () => {
    const transactions = [
      paymentVerifiedTransaction(amounts),
      deliveryConfirmedTransaction(amounts),
      settlementPaidTransaction('producer', amounts.providerNet),
      settlementPaidTransaction('carrier', amounts.freight),
    ];
    expect(transactions.every(isBalanced)).toBe(true);
    // After settlement only the commission stays with TRACOP, backed by the cash still held.
    expect(balance(transactions)).toEqual({ cash_held: 5_000n, revenue_commission: -5_000n });
  });

  it('records the expected lines on payment verification and delivery', () => {
    expect(paymentVerifiedTransaction(amounts).lines).toEqual([
      { account: 'cash_held', debit: 120_000n, credit: 0n },
      { account: 'payable_buyer_funds', debit: 0n, credit: 120_000n },
    ]);
    expect(deliveryConfirmedTransaction(amounts).lines).toEqual([
      { account: 'payable_buyer_funds', debit: 120_000n, credit: 0n },
      { account: 'payable_producer', debit: 0n, credit: 95_000n },
      { account: 'payable_carrier', debit: 0n, credit: 20_000n },
      { account: 'revenue_commission', debit: 0n, credit: 5_000n },
    ]);
  });

  it('drops zero lines when there is no freight or commission', () => {
    const plain: PaymentAmounts = {
      subtotal: 50_000n,
      freight: 0n,
      commission: 0n,
      total: 50_000n,
      providerNet: 50_000n,
    };
    expect(deliveryConfirmedTransaction(plain).lines).toEqual([
      { account: 'payable_buyer_funds', debit: 50_000n, credit: 0n },
      { account: 'payable_producer', debit: 0n, credit: 50_000n },
    ]);
  });

  it('balances with a commission that was rounded when the order was quoted', () => {
    // 33 333 COP at 7.5 % is 2 499.975, which the quote rounds half up to 2 500.
    const quote: PaymentAmounts = {
      subtotal: 33_333n,
      freight: 12_000n,
      commission: 2_500n,
      total: 45_333n,
      providerNet: 30_833n,
    };
    const transactions = [
      paymentVerifiedTransaction(quote),
      deliveryConfirmedTransaction(quote),
      settlementPaidTransaction('producer', quote.providerNet),
      settlementPaidTransaction('carrier', quote.freight),
    ];
    expect(transactions.every(isBalanced)).toBe(true);
    expect(balance(transactions)).toEqual({
      cash_held: quote.commission,
      revenue_commission: -quote.commission,
    });
  });

  it('refunds before delivery from the buyer funds and after it from the payables', () => {
    const beforeDelivery = [paymentVerifiedTransaction(amounts), refundTransaction(amounts, false)];
    expect(beforeDelivery.every(isBalanced)).toBe(true);
    expect(balance(beforeDelivery)).toEqual({});

    const afterDelivery = [
      paymentVerifiedTransaction(amounts),
      deliveryConfirmedTransaction(amounts),
      refundTransaction(amounts, true),
    ];
    expect(afterDelivery.every(isBalanced)).toBe(true);
    expect(balance(afterDelivery)).toEqual({});
  });

  it('refuses inconsistent amounts and empty settlements', () => {
    expect(() => paymentVerifiedTransaction({ ...amounts, total: 1n })).toThrow(
      expect.objectContaining({ code: 'invalid_amounts' }),
    );
    expect(() => settlementPaidTransaction('carrier', 0n)).toThrow(
      expect.objectContaining({ code: 'unbalanced_ledger' }),
    );
    expect(() => settlementPaidTransaction('producer', -10n)).toThrow(
      expect.objectContaining({ code: 'invalid_ledger_line' }),
    );
  });
});
