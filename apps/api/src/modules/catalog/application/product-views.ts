import type { ProductProps, ProductStatus } from '../domain/product.js';

/**
 * What any authenticated user (and the global sync feed) may see of a product.
 * Who proposed or reviewed it are identifiers of other users and stay with staff.
 */
export interface PublicProductView {
  readonly id: string;
  readonly categoryId: string;
  readonly name: string;
  readonly unit: ProductProps['unit'];
  readonly attributes: ProductProps['attributes'];
  readonly status: ProductStatus;
}

/** A proposer also learns why their own proposal was rejected. */
export interface ProposerProductView extends PublicProductView {
  readonly rejectionReason: string | null;
}

export const toPublicProductView = (product: ProductProps): PublicProductView => ({
  id: product.id,
  categoryId: product.categoryId,
  name: product.name,
  unit: product.unit,
  attributes: product.attributes,
  status: product.status ?? 'approved',
});

export const toProposerProductView = (product: ProductProps): ProposerProductView => ({
  ...toPublicProductView(product),
  rejectionReason: product.status === 'rejected' ? (product.rejectionReason ?? null) : null,
});
