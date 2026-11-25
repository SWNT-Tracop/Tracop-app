import { Global, Module } from '@nestjs/common';
import { LogisticsModule, TripPlanningService } from '../modules/logistics/index.js';
import { OrderingModule, OrderingService } from '../modules/ordering/index.js';
import {
  DELIVERING_CARRIER_PORT,
  PAYMENT_ORDER_PORT,
  type DeliveringCarrierPort,
  type PaymentOrderPort,
  type PaymentOrderSnapshot,
} from '../modules/payments/index.js';

/** Payments drives orders only through ordering's public payment use cases. */
export class OrderingPaymentsAdapter implements PaymentOrderPort {
  constructor(private readonly ordering: OrderingService) {}

  async getOrder(orderId: string): Promise<PaymentOrderSnapshot | null> {
    const aggregate = await this.ordering.getForPayment(orderId);
    if (!aggregate) return null;
    const { quote } = aggregate;
    return {
      orderId: aggregate.order.id,
      buyerId: aggregate.order.buyerId,
      providerId: aggregate.order.providerId,
      status: aggregate.order.status,
      amounts: {
        subtotal: quote.subtotal,
        freight: quote.freight,
        commission: quote.commission,
        total: quote.total,
        providerNet: quote.providerNet,
      },
    };
  }

  async startPayment(orderId: string, buyerId: string): Promise<void> {
    await this.ordering.startPayment(orderId, buyerId);
  }

  async holdStockForReview(orderId: string): Promise<void> {
    await this.ordering.holdStockForPaymentReview(orderId);
  }

  async resumeStockExpiry(orderId: string, expiresAt: Date): Promise<void> {
    await this.ordering.resumeStockExpiry(orderId, expiresAt);
  }

  async markPaid(orderId: string, actorId: string): Promise<void> {
    await this.ordering.markPaid(orderId, actorId);
  }

  async markDisputed(orderId: string, actorId: string): Promise<void> {
    await this.ordering.markDisputed(orderId, actorId);
  }

  async close(orderId: string, actorId: string | null): Promise<void> {
    await this.ordering.closeOrder(orderId, actorId);
  }
}

export class LogisticsDeliveringCarrierAdapter implements DeliveringCarrierPort {
  constructor(private readonly trips: TripPlanningService) {}

  findDeliveringCarrier(orderId: string): Promise<string | null> {
    return this.trips.findDeliveringCarrier(orderId);
  }
}

@Global()
@Module({
  imports: [OrderingModule, LogisticsModule],
  providers: [
    {
      provide: PAYMENT_ORDER_PORT,
      inject: [OrderingService],
      useFactory: (ordering: OrderingService) => new OrderingPaymentsAdapter(ordering),
    },
    {
      provide: DELIVERING_CARRIER_PORT,
      inject: [TripPlanningService],
      useFactory: (trips: TripPlanningService) => new LogisticsDeliveringCarrierAdapter(trips),
    },
  ],
  exports: [PAYMENT_ORDER_PORT, DELIVERING_CARRIER_PORT],
})
export class PaymentsBridgeModule {}
