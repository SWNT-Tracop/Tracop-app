import { Global, Module } from '@nestjs/common';
import {
  PROVIDER_TRUST,
  type ProviderTrustPort as CatalogProviderTrustPort,
} from '../modules/catalog/index.js';
import { LogisticsModule, TripPlanningService } from '../modules/logistics/index.js';
import {
  ORDER_PROVIDER_TRUST,
  OrderingModule,
  OrderingService,
  type ProviderTrustPort as OrderingProviderTrustPort,
} from '../modules/ordering/index.js';
import {
  PAYMENTS_SERVICE,
  PaymentsModule,
  type PaymentsService,
} from '../modules/payments/index.js';
import {
  ORDER_DELIVERY_INFO_PORT,
  TRUST_SERVICE,
  TrustModule,
  type OrderDeliveryInfo,
  type OrderDeliveryInfoPort,
  type TrustService,
} from '../modules/trust/index.js';

/** Who took part in a delivered order, from ordering, logistics and payments' public APIs. */
export class OrderDeliveryInfoAdapter implements OrderDeliveryInfoPort {
  constructor(
    private readonly ordering: OrderingService,
    private readonly trips: TripPlanningService,
    private readonly payments: PaymentsService,
  ) {}

  async get(orderId: string): Promise<OrderDeliveryInfo | null> {
    const record = await this.ordering.getDeliveryRecord(orderId);
    if (!record) return null;
    const [carrierId, paymentVerified] = await Promise.all([
      this.trips.findDeliveringCarrier(orderId),
      this.payments.hasVerifiedPayment(orderId),
    ]);
    return {
      orderId,
      buyerId: record.buyerId,
      providerId: record.providerId,
      carrierId,
      deliveredAt: record.deliveredAt,
      deliveryWindow: record.deliveryWindow,
      paymentVerified,
    };
  }
}

/** Trust is given the delivery facts; it imports no other module. */
@Global()
@Module({
  imports: [OrderingModule, LogisticsModule, PaymentsModule],
  providers: [
    {
      provide: ORDER_DELIVERY_INFO_PORT,
      inject: [OrderingService, TripPlanningService, PAYMENTS_SERVICE],
      useFactory: (
        ordering: OrderingService,
        trips: TripPlanningService,
        payments: PaymentsService,
      ) => new OrderDeliveryInfoAdapter(ordering, trips, payments),
    },
  ],
  exports: [ORDER_DELIVERY_INFO_PORT],
})
export class TrustDeliveryBridgeModule {}

/** One batched trust lookup for catalog and ordering (no N+1). */
export class ProviderTrustAdapter implements CatalogProviderTrustPort, OrderingProviderTrustPort {
  constructor(private readonly trust: TrustService) {}

  get(providerIds: readonly string[]) {
    return this.trust.providerTrust(providerIds);
  }
}

@Global()
@Module({
  imports: [TrustModule],
  providers: [
    {
      provide: PROVIDER_TRUST,
      inject: [TRUST_SERVICE],
      useFactory: (trust: TrustService) => new ProviderTrustAdapter(trust),
    },
    { provide: ORDER_PROVIDER_TRUST, useExisting: PROVIDER_TRUST },
  ],
  exports: [PROVIDER_TRUST, ORDER_PROVIDER_TRUST],
})
export class ProviderTrustBridgeModule {}
