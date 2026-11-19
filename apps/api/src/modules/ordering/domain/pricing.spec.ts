import { calculateQuoteAmounts, MAX_COP } from './pricing.js';

const configuration = {
  commissionRateBps: 0n,
  freightCop: 0n,
  subtotalRounding: 'half_up' as const,
};

describe('ordering pricing', () => {
  it.each([
    ['half_up', 1n],
    ['floor', 0n],
    ['ceil', 1n],
  ] as const)('rounds the aggregated fractional COP using %s', (mode, expected) => {
    expect(
      calculateQuoteAmounts([{ unitPrice: 1n, quantityMilli: 500n }], {
        ...configuration,
        subtotalRounding: mode,
      }).subtotal,
    ).toBe(expected);
  });

  it('rounds after summing exact milli-COP numerators, not per line', () => {
    expect(
      calculateQuoteAmounts(
        [
          { unitPrice: 1n, quantityMilli: 500n },
          { unitPrice: 1n, quantityMilli: 500n },
        ],
        configuration,
      ).subtotal,
    ).toBe(1n);
  });

  it('keeps bigint amounts above Number.MAX_SAFE_INTEGER exact and rejects overflow', () => {
    const large = BigInt(Number.MAX_SAFE_INTEGER) + 123n;
    expect(
      calculateQuoteAmounts([{ unitPrice: large, quantityMilli: 1000n }], configuration).subtotal,
    ).toBe(large);
    expect(() =>
      calculateQuoteAmounts([{ unitPrice: MAX_COP, quantityMilli: 2000n }], configuration),
    ).toThrow('excede');
  });

  it.each([
    [{ commissionRateBps: -1n }, 'invalid_pricing_configuration'],
    [{ commissionRateBps: 10_001n }, 'invalid_pricing_configuration'],
    [{ freightCop: -1n }, 'invalid_pricing_configuration'],
    [{ freightCop: MAX_COP + 1n }, 'invalid_pricing_configuration'],
  ] as const)('rejects invalid pricing configuration', (override, code) => {
    expect(() =>
      calculateQuoteAmounts([{ unitPrice: 1n, quantityMilli: 1000n }], {
        ...configuration,
        ...override,
      }),
    ).toThrow(expect.objectContaining({ code }));
  });

  it('rejects invalid order lines', () => {
    expect(() =>
      calculateQuoteAmounts([{ unitPrice: -1n, quantityMilli: 1000n }], configuration),
    ).toThrow(expect.objectContaining({ code: 'invalid_order_line' }));
    expect(() =>
      calculateQuoteAmounts([{ unitPrice: 1n, quantityMilli: 0n }], configuration),
    ).toThrow(expect.objectContaining({ code: 'invalid_order_line' }));
  });
});
