import { Product } from './product.js';

describe('Product', () => {
  it('trims names and permits a closed unit value', () => {
    expect(
      Product.create({ id: 'p1', categoryId: 'c1', name: ' Papa ', unit: 'kg', attributes: {} })
        .props.name,
    ).toBe('Papa');
  });
  it('rejects invalid names and unsupported units', () => {
    expect(() =>
      Product.create({ id: 'p1', categoryId: 'c1', name: ' ', unit: 'kg', attributes: {} }),
    ).toThrow();
    expect(() =>
      Product.create({
        id: 'p1',
        categoryId: 'c1',
        name: 'Papa',
        unit: 'l' as never,
        attributes: {},
      }),
    ).toThrow();
  });
});
