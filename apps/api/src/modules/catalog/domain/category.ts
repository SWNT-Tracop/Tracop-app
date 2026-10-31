import { DomainError } from '../../../shared/kernel/domain-error.js';

export interface CategoryProps {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly depth: number;
}

export class Category {
  private constructor(readonly props: CategoryProps) {}

  static create(props: CategoryProps): Category {
    const name = props.name.trim();
    if (!name || name.length > 100)
      throw new DomainError('Nombre de categoría inválido.', 'invalid_category');
    if (props.depth < 1 || props.depth > 3)
      throw new DomainError('La categoría supera profundidad máxima 3.', 'category_depth');
    if (props.parentId === props.id)
      throw new DomainError('Una categoría no puede ser su propia padre.', 'category_cycle');
    return new Category({ ...props, name });
  }

  static assertNoCycle(categoryId: string, parentAncestors: readonly string[]): void {
    if (parentAncestors.includes(categoryId))
      throw new DomainError('El árbol de categorías contiene un ciclo.', 'category_cycle');
    if (parentAncestors.length >= 3)
      throw new DomainError('La categoría supera profundidad máxima 3.', 'category_depth');
  }
}
