import { Global, Module } from '@nestjs/common';
import {
  PRICE_SUGGESTION_PORT,
  type PriceSuggestion,
  type PriceSuggestionPort,
} from '../modules/ai-assistant/index.js';
import { CatalogModule, CatalogService } from '../modules/catalog/index.js';
import { OrderingModule, OrderingService } from '../modules/ordering/index.js';
import {
  CATALOG_FACTS_PORT,
  ORDER_FACTS_PORT,
  PROVIDER_VERIFICATION_PORT,
  RECOMMENDATIONS_SERVICE,
  RecommendationsModule,
  type AcceptedOrderFacts,
  type AvailableLot,
  type CatalogFactsPort,
  type OrderFactsPort,
  type ProviderVerificationPort,
  type PublishedLotFacts,
  type RecommendationsService,
} from '../modules/recommendations/index.js';
import { TRUST_SERVICE, TrustModule, type TrustService } from '../modules/trust/index.js';

const SEARCH_PAGE = 50;

/** catalog's public use cases for recommendations; coordinates never leave this adapter. */
export class RecommendationsCatalogAdapter implements CatalogFactsPort {
  constructor(private readonly catalog: CatalogService) {}

  async publishedLot(lotId: string): Promise<PublishedLotFacts | null> {
    const lot = await this.catalog.getLotFacts(lotId);
    if (!lot || lot.status !== 'published') return null;
    return {
      lotId: lot.id,
      providerId: lot.providerId,
      productId: lot.productId,
      unitPrice: lot.unitPrice,
      lat: lot.locationLat,
      lng: lot.locationLng,
    };
  }

  async lotProduct(lotId: string) {
    const lot = await this.catalog.getLotFacts(lotId);
    return lot ? { productId: lot.productId, unit: lot.unit } : null;
  }

  productUnit(productId: string): Promise<string | null> {
    return this.catalog.getApprovedProductUnit(productId);
  }

  async availableLots(query: {
    readonly lat?: number;
    readonly lng?: number;
    readonly radiusKm?: number;
    readonly limit: number;
  }): Promise<readonly AvailableLot[]> {
    const lots: AvailableLot[] = [];
    let cursor: Parameters<CatalogService['searchVisibleLots']>[0]['cursor'];
    while (lots.length < query.limit) {
      const page = await this.catalog.searchVisibleLots({
        limit: Math.min(SEARCH_PAGE, query.limit - lots.length),
        sort: 'recent',
        ...(query.lat !== undefined && query.lng !== undefined && query.radiusKm !== undefined
          ? { lat: query.lat, lng: query.lng, radiusKm: query.radiusKm }
          : {}),
        ...(cursor ? { cursor } : {}),
      });
      for (const { lot, distanceKm } of page.items) {
        if (lot.status !== 'published' || (lot.availableQuantityMilli ?? 1n) <= 0n) continue;
        lots.push({
          lotId: lot.id,
          providerId: lot.providerId,
          productId: lot.productId,
          unit: lot.unit,
          unitPrice: lot.unitPrice,
          availableFrom: lot.availableFrom,
          // The privacy rule of the lot search: a whole number of kilometres, at least 1.
          distanceKm: distanceKm === undefined ? null : Math.max(1, Math.round(distanceKm)),
        });
      }
      if (!page.nextCursor || page.items.length === 0) break;
      cursor = page.nextCursor;
    }
    return lots;
  }
}

/** ordering's public read of an order (lines and parties) for price observations. */
export class RecommendationsOrderAdapter implements OrderFactsPort {
  constructor(private readonly ordering: OrderingService) {}

  async order(orderId: string): Promise<AcceptedOrderFacts | null> {
    const aggregate = await this.ordering.getForPayment(orderId);
    if (!aggregate?.order.acceptedAt) return null;
    return {
      orderId,
      buyerId: aggregate.order.buyerId,
      providerId: aggregate.order.providerId,
      acceptedAt: aggregate.order.acceptedAt,
      lines: aggregate.lines.map((line) => ({
        lineId: line.id,
        lotId: line.lotId,
        unitPrice: line.unitPrice,
        unit: line.unit,
      })),
    };
  }
}

export class RecommendationsTrustAdapter implements ProviderVerificationPort {
  constructor(private readonly trust: TrustService) {}

  async verified(providerIds: readonly string[]): Promise<ReadonlySet<string>> {
    if (providerIds.length === 0) return new Set();
    const summaries = await this.trust.providerTrust(providerIds);
    return new Set([...summaries].filter(([, summary]) => summary.verified).map(([id]) => id));
  }
}

/** The assistant's price suggestion: the median of the range, with its sources and date. */
export class AssistantPriceSuggestionAdapter implements PriceSuggestionPort {
  constructor(private readonly recommendations: RecommendationsService) {}

  async suggest(productId: string, unit: string): Promise<PriceSuggestion | null> {
    const view = await this.recommendations.suggestionFor(productId, unit).catch(() => null);
    if (!view || view.suggestion.status !== 'ok') return null;
    const { sources, median } = view.suggestion;
    return {
      unitPrice: median,
      source: sources.map(({ name }) => name).join(' y '),
      observedAt: new Date(Math.max(...sources.map(({ observedAt }) => observedAt.getTime()))),
    };
  }
}

@Global()
@Module({
  imports: [CatalogModule, OrderingModule, TrustModule],
  providers: [
    {
      provide: CATALOG_FACTS_PORT,
      inject: [CatalogService],
      useFactory: (catalog: CatalogService) => new RecommendationsCatalogAdapter(catalog),
    },
    {
      provide: ORDER_FACTS_PORT,
      inject: [OrderingService],
      useFactory: (ordering: OrderingService) => new RecommendationsOrderAdapter(ordering),
    },
    {
      provide: PROVIDER_VERIFICATION_PORT,
      inject: [TRUST_SERVICE],
      useFactory: (trust: TrustService) => new RecommendationsTrustAdapter(trust),
    },
  ],
  exports: [CATALOG_FACTS_PORT, ORDER_FACTS_PORT, PROVIDER_VERIFICATION_PORT],
})
export class RecommendationsFactsBridgeModule {}

/** recommendations → the assistant's PriceSuggestionPort (phase 8 replaces the null adapter). */
@Global()
@Module({
  imports: [RecommendationsModule],
  providers: [
    {
      provide: PRICE_SUGGESTION_PORT,
      inject: [RECOMMENDATIONS_SERVICE],
      useFactory: (recommendations: RecommendationsService) =>
        new AssistantPriceSuggestionAdapter(recommendations),
    },
  ],
  exports: [PRICE_SUGGESTION_PORT],
})
export class AssistantPriceBridgeModule {}
