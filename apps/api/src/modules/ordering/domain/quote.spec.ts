import { Quote } from './quote.js';

const baseQuote = {
  id: '018f47a2-8b45-7cc2-9a1e-123456789abc',
  orderId: '018f47a2-8b45-7cc2-9a1e-123456789abd',
  subtotal: 5000n,
  freight: 0n,
  commission: 0n,
  total: 5000n,
  providerNet: 5000n,
  validUntil: new Date('2026-11-19T12:00:00.000Z'),
  status: 'active' as const,
};

describe('Quote', () => {
  it('validates active quotes at the boundary', () => {
    const quote = Quote.create(baseQuote);
    expect(quote.isValidAt(new Date('2026-11-19T12:00:00.000Z'))).toBe(true);
    expect(quote.isValidAt(new Date('2026-11-19T12:00:00.001Z'))).toBe(false);
  });

  it('rejects non-positive expiration dates', () => {
    expect(() => Quote.create({ ...baseQuote, validUntil: new Date(0) })).toThrow(
      expect.objectContaining({ code: 'invalid_quote' }),
    );
  });

  it.each(['accepted', 'expired', 'cancelled'] as const)(
    'rejects %s quotes as invalid',
    (status) => {
      expect(Quote.create({ ...baseQuote, status }).isValidAt(new Date())).toBe(false);
    },
  );
});
