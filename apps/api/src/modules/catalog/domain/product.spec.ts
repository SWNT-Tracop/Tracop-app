import { Product, matchProductNames } from './product.js';

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

describe('matchProductNames', () => {
  it.each([
    ['Papa', 'papa', 'exact'],
    ['Papá criolla', 'papa  CRIOLLA', 'exact'],
    ['Papa', 'Papa criolla', 'similar'],
    ['Papa criolla', 'Papa', 'similar'],
    ['Criolla papa', 'Papa criolla', 'similar'],
    ['Papa', 'Papaya', 'none'],
    ['Papa pastusa', 'Papa criolla', 'none'],
    ['Tomate', 'Tomate de árbol', 'similar'],
  ] as const)('%s vs %s → %s', (proposed, existing, expected) => {
    expect(matchProductNames(proposed, existing)).toBe(expected);
  });
});
