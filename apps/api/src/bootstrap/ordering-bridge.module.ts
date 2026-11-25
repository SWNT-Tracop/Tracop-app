import { Global, Module } from '@nestjs/common';
import { CatalogModule } from '../modules/catalog/index.js';
import {
  LOT_QUOTE_PORT,
  LOT_RESERVATION_PORT,
  type LotQuotePort,
  type LotReservationPort,
  type LotQuoteSnapshot,
} from '../modules/ordering/index.js';
import { CATALOG_ORDERING_API, type CatalogOrderingApi } from '../modules/catalog/index.js';
import {
  IdentityModule,
  ProviderProfileService,
  PROVIDER_PROFILE_SERVICE,
} from '../modules/identity/index.js';
import {
  ORDER_PROVIDER_DIRECTORY,
  type ProviderDirectoryPort,
  type ProviderPublicSummary,
} from '../modules/ordering/index.js';

export class CatalogLotQuoteAdapter implements LotQuotePort {
  constructor(private readonly api: CatalogOrderingApi) {}

  async getQuote(lotId: string): Promise<LotQuoteSnapshot> {
    return this.api.getLotQuote(lotId);
  }
}

export class CatalogLotReservationAdapter implements LotReservationPort {
  constructor(private readonly api: CatalogOrderingApi) {}

  async reserve(
    orderId: string,
    lines: readonly { lotId: string; quantityMilli: bigint }[],
    expiresAt: Date,
  ): Promise<void> {
    await this.api.reserveLots({ orderId, lines, expiresAt });
  }

  async release(orderId: string): Promise<void> {
    await this.api.releaseOrderReservations(orderId);
  }

  async findExpiredOrderIds(now: Date, limit: number): Promise<readonly string[]> {
    return this.api.findExpiredReservationOrderIds(now, limit);
  }

  async hold(orderId: string): Promise<void> {
    await this.api.holdOrderReservations(orderId);
  }

  async resumeExpiry(orderId: string, expiresAt: Date): Promise<void> {
    await this.api.resumeOrderReservationExpiry(orderId, expiresAt);
  }

  async consume(orderId: string): Promise<void> {
    await this.api.consumeOrderReservations(orderId);
  }

  async isExpired(orderId: string, now: Date): Promise<boolean> {
    return this.api.isOrderReservationExpired(orderId, now);
  }
}

export class OrderingProviderDirectoryAdapter implements ProviderDirectoryPort {
  constructor(private readonly profiles: ProviderProfileService) {}

  getProviderPublicSummaries(
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, ProviderPublicSummary>> {
    return this.profiles.getProviderPublicSummaries(ids);
  }
}

@Global()
@Module({
  imports: [CatalogModule, IdentityModule],
  providers: [
    {
      provide: ORDER_PROVIDER_DIRECTORY,
      inject: [PROVIDER_PROFILE_SERVICE],
      useFactory: (profiles: ProviderProfileService) =>
        new OrderingProviderDirectoryAdapter(profiles),
    },
    {
      provide: LOT_QUOTE_PORT,
      inject: [CATALOG_ORDERING_API],
      useFactory: (api: CatalogOrderingApi) => new CatalogLotQuoteAdapter(api),
    },
    {
      provide: LOT_RESERVATION_PORT,
      inject: [CATALOG_ORDERING_API],
      useFactory: (api: CatalogOrderingApi) => new CatalogLotReservationAdapter(api),
    },
  ],
  exports: [LOT_QUOTE_PORT, LOT_RESERVATION_PORT, ORDER_PROVIDER_DIRECTORY],
})
export class OrderingBridgeModule {}
