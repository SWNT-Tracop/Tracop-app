import {
  MAX_QUANTITY_MILLI,
  quantityDecimalToMilli,
  quantityMilliToDecimal,
  subtotalMilliCop,
} from './lot.js';

describe('catalog quantity in thousandths', () => {
  it.each([
    ['0.001', 1n, '0.001'],
    ['12.3', 12_300n, '12.300'],
    ['999999999.999', MAX_QUANTITY_MILLI, '999999999.999'],
  ])('converts exact decimal %s to milli-units and back', (decimal, milli, normalized) => {
    expect(quantityDecimalToMilli(decimal)).toBe(milli);
    expect(quantityMilliToDecimal(milli)).toBe(normalized);
  });

  it('calculates subtotal in integer milli-COP without rounding', () => {
    expect(subtotalMilliCop(125n, 1n)).toBe(125n);
    expect(subtotalMilliCop(3_200n, 25_125n)).toBe(80_400_000n);
  });

  it.each(['1000000000.000', '1.0001', '01.2', '-1.000'])(
    'rejects invalid numeric(12,3) value %s',
    (value) => {
      expect(() => quantityDecimalToMilli(value)).toThrow();
    },
  );
});
