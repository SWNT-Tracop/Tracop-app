import { DomainError } from '../../../shared/kernel/domain-error.js';

export const PRODUCT_UNITS = [
  'kg',
  'g',
  'lb',
  'und',
  'docena',
  'arroba',
  'quintal',
  'caja',
  'mano',
  'bulto',
] as const;
export type ProductUnit = (typeof PRODUCT_UNITS)[number];

export interface ProductProps {
  readonly id: string;
  readonly categoryId: string;
  readonly name: string;
  readonly unit: ProductUnit;
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
}

export class Product {
  private constructor(readonly props: ProductProps) {}

  static create(props: ProductProps): Product {
    if (!props.name.trim() || props.name.trim().length > 120)
      throw new DomainError('Nombre de producto inválido.', 'invalid_product');
    if (!PRODUCT_UNITS.includes(props.unit))
      throw new DomainError('Unidad de producto no soportada.', 'invalid_unit');
    return new Product({ ...props, name: props.name.trim() });
  }
}
