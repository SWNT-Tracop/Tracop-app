import { OrderLine } from './order-line.js';

const baseLine = {
  id: '018f47a2-8b45-7cc2-9a1e-123456789abc',
  lotId: '018f47a2-8b45-7cc2-9a1e-123456789abd',
  providerId: 'provider',
  quantityMilli: 1000n,
  unitPrice: 5000n,
  unit: 'kg',
};

describe('OrderLine', () => {
  it('creates a valid line', () => {
    expect(OrderLine.create(baseLine).props).toEqual(baseLine);
  });

  it.each([
    ['zero quantity', { quantityMilli: 0n }, 'invalid_order_line'],
    ['negative quantity', { quantityMilli: -1n }, 'invalid_order_line'],
    ['negative price', { unitPrice: -1n }, 'invalid_order_line'],
  ] as const)('rejects %s', (_description, overrides, code) => {
    expect(() => OrderLine.create({ ...baseLine, ...overrides })).toThrow(
      expect.objectContaining({ code }),
    );
  });
});
