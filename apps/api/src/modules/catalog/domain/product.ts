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
export type ProductStatus = 'approved' | 'pending_review' | 'rejected';

export interface ProductProps {
  readonly id: string;
  readonly categoryId: string;
  readonly name: string;
  readonly unit: ProductUnit;
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
  readonly status?: ProductStatus;
  readonly proposedBy?: string | null;
  readonly reviewedBy?: string | null;
  readonly reviewedAt?: Date | null;
  readonly rejectionReason?: string | null;
}

/** Review state of a product curated by staff: approved, never proposed, nothing to review. */
export const CURATED_REVIEW_STATE = {
  status: 'approved',
  proposedBy: null,
  reviewedBy: null,
  reviewedAt: null,
  rejectionReason: null,
} as const satisfies Partial<ProductProps>;

export class Product {
  private constructor(readonly props: ProductProps) {}

  static create(props: ProductProps): Product {
    if (!props.name.trim() || props.name.trim().length > 120)
      throw new DomainError('Nombre de producto inválido.', 'invalid_product');
    if (!PRODUCT_UNITS.includes(props.unit))
      throw new DomainError('Unidad de producto no soportada.', 'invalid_unit');
    return new Product({ ...props, name: props.name.trim(), status: props.status ?? 'approved' });
  }
}

export type ProductNameMatch = 'exact' | 'similar' | 'none';

/**
 * Compares a proposed product name with an existing one by complete normalized tokens.
 * `exact`: same normalized name. `similar`: the token set of one contains the other's
 * (including the same tokens in another order). `none`: otherwise, so a shared substring
 * ("papa" in "papaya") or a partial overlap ("papa criolla" vs "papa pastusa") is not a match.
 */
export const matchProductNames = (proposed: string, existing: string): ProductNameMatch => {
  const proposedText = normalizeProductSearchText(proposed);
  const existingText = normalizeProductSearchText(existing);
  if (proposedText === existingText) return 'exact';
  const proposedTokens = new Set(proposedText.split(' '));
  const existingTokens = new Set(existingText.split(' '));
  const containedIn = (inner: Set<string>, outer: Set<string>) =>
    [...inner].every((token) => outer.has(token));
  return containedIn(proposedTokens, existingTokens) || containedIn(existingTokens, proposedTokens)
    ? 'similar'
    : 'none';
};

export const normalizeProductSearchText = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es-CO')
    .trim()
    .replace(/\s+/g, ' ');
