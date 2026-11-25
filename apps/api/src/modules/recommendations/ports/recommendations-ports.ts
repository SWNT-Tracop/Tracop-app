import type { AlertProps, PublishedLotFacts } from '../domain/alerts.js';
import type { Observation } from '../domain/pricing.js';
import type { ReferenceRow } from '../domain/reference-csv.js';

// -------------------------------------------------- other modules (adapted in bootstrap)

export interface AvailableLot {
  readonly lotId: string;
  readonly providerId: string;
  readonly productId: string;
  readonly unit: string;
  readonly unitPrice: bigint;
  readonly availableFrom: Date;
  /** Integer kilometres from the query point; null without one. */
  readonly distanceKm: number | null;
}

export interface CatalogFactsPort {
  /** A published lot's facts for alerts; null if it is not published. */
  publishedLot(lotId: string): Promise<PublishedLotFacts | null>;
  /** The product and unit of a lot (for order lines). */
  lotProduct(lotId: string): Promise<{ readonly productId: string; readonly unit: string } | null>;
  /** The catalog unit of an approved product, or null. */
  productUnit(productId: string): Promise<string | null>;
  /** Available lots (catalog's public search), at most `limit`. */
  availableLots(query: {
    readonly lat?: number;
    readonly lng?: number;
    readonly radiusKm?: number;
    readonly limit: number;
  }): Promise<readonly AvailableLot[]>;
}

export interface AcceptedOrderFacts {
  readonly orderId: string;
  readonly buyerId: string;
  readonly providerId: string;
  readonly acceptedAt: Date;
  readonly lines: readonly {
    readonly lineId: string;
    readonly lotId: string;
    readonly unitPrice: bigint;
    readonly unit: string;
  }[];
}

export interface OrderFactsPort {
  order(orderId: string): Promise<AcceptedOrderFacts | null>;
}

export interface ProviderVerificationPort {
  /** Which of these providers are verified (≤ 50 ids per call). */
  verified(providerIds: readonly string[]): Promise<ReadonlySet<string>>;
}

// --------------------------------------------------------------------- persistence

export interface SourceMapping {
  readonly id: string;
  readonly productId: string;
  readonly unit: string;
  readonly source: 'DANE-SIPSA';
  readonly sourceProduct: string;
  readonly presentation: string;
  readonly createdAt: Date;
}

export interface RecommendationsRepository {
  /** Serializes imports of one file. */
  lockImport(fileSha256: string): Promise<void>;
  findImport(fileSha256: string): Promise<{ readonly id: string; readonly rows: number } | null>;
  insertImport(input: {
    readonly id: string;
    readonly fileSha256: string;
    readonly rows: readonly ReferenceRow[];
    readonly importedAt: Date;
  }): Promise<number>;

  mappings(productId?: string): Promise<readonly SourceMapping[]>;
  insertMapping(mapping: SourceMapping & { readonly createdBy: string }): Promise<boolean>;
  deleteMapping(id: string): Promise<SourceMapping | null>;

  /** Reference prices of the mapped sources of a product and unit since a date. */
  referencePrices(
    productId: string,
    unit: string,
    since: string,
  ): Promise<readonly { readonly price: bigint; readonly observedAt: Date }[]>;
  observations(productId: string, unit: string, since: Date): Promise<readonly Observation[]>;

  /** Records an order once: its observations and the buyer's history. False if seen. */
  recordOrder(input: {
    readonly orderId: string;
    readonly buyerId: string;
    readonly at: Date;
    readonly observations: readonly {
      readonly id: string;
      readonly orderLineKey: string;
      readonly productId: string;
      readonly unit: string;
      readonly unitPrice: bigint;
      readonly providerKey: string;
    }[];
  }): Promise<boolean>;
  markDelivered(orderLineKeys: readonly string[], at: Date): Promise<number>;
  purchasedProducts(buyerId: string): Promise<ReadonlySet<string>>;

  countAlerts(buyerId: string): Promise<number>;
  insertAlert(alert: AlertProps): Promise<'created' | 'exists'>;
  findAlert(id: string): Promise<(AlertProps & { readonly deleted: boolean }) | null>;
  listAlerts(buyerId: string): Promise<readonly AlertProps[]>;
  deleteAlert(id: string, buyerId: string, at: Date): Promise<boolean>;
  alertsForProduct(productId: string): Promise<readonly AlertProps[]>;
  /** True only the first time an (alert, lot) pair is recorded. */
  recordMatch(alertId: string, lotId: string, at: Date): Promise<boolean>;
  lockBuyer(buyerId: string): Promise<void>;
}

export interface RecommendationsRateLimit {
  /** Seconds to wait, or 0 when allowed. */
  take(key: string): number;
}

export const CATALOG_FACTS_PORT = Symbol('CATALOG_FACTS_PORT');
export const ORDER_FACTS_PORT = Symbol('ORDER_FACTS_PORT');
export const PROVIDER_VERIFICATION_PORT = Symbol('PROVIDER_VERIFICATION_PORT');
export const RECOMMENDATIONS_CLOCK = Symbol('RECOMMENDATIONS_CLOCK');
