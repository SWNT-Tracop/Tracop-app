import { Global, Module } from '@nestjs/common';
import {
  CATALOG_ORDERING_API,
  CatalogModule,
  type CatalogOrderingApi,
} from '../modules/catalog/index.js';
import { ORDER_LOCATION_PORT, type OrderLocationPort } from '../modules/logistics/index.js';
import { OrderingModule, OrderingService } from '../modules/ordering/index.js';

/**
 * Where an order is picked up (its lots' coordinates, from catalog) and delivered (its address,
 * from ordering). Both APIs are internal: no controller exposes them; logistics authorizes.
 */
export class OrderLocationAdapter implements OrderLocationPort {
  constructor(
    private readonly ordering: OrderingService,
    private readonly catalog: CatalogOrderingApi,
  ) {}

  async pickupPoints(orderId: string) {
    const details = await this.ordering.getDeliveryDetails(orderId);
    if (!details) return [];
    const locations = await this.catalog.getLotLocations(details.lotIds);
    return details.lotIds.flatMap((lotId) => locations.get(lotId) ?? []);
  }

  async deliveryAddress(orderId: string): Promise<string | null> {
    return (await this.ordering.getDeliveryDetails(orderId))?.deliveryAddress ?? null;
  }
}

@Global()
@Module({
  imports: [OrderingModule, CatalogModule],
  providers: [
    {
      provide: ORDER_LOCATION_PORT,
      inject: [OrderingService, CATALOG_ORDERING_API],
      useFactory: (ordering: OrderingService, catalog: CatalogOrderingApi) =>
        new OrderLocationAdapter(ordering, catalog),
    },
  ],
  exports: [ORDER_LOCATION_PORT],
})
export class LogisticsLocationBridgeModule {}
