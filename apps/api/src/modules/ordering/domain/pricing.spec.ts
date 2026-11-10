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
});
