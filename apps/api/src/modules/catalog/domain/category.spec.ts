import { Category } from './category.js';

describe('Category tree rules', () => {
  it('accepts maximum depth three', () => {
    expect(
      Category.create({ id: 'c3', name: 'Nivel 3', parentId: 'c2', depth: 3 }).props.depth,
    ).toBe(3);
  });
  it('rejects depth four and ancestor cycles', () => {
    expect(() =>
      Category.create({ id: 'c4', name: 'Nivel 4', parentId: 'c3', depth: 4 }),
    ).toThrow();
    expect(() => Category.assertNoCycle('root', ['root', 'child'])).toThrow('ciclo');
    expect(() => Category.assertNoCycle('new', ['a', 'b', 'c'])).toThrow('profundidad');
  });
});
