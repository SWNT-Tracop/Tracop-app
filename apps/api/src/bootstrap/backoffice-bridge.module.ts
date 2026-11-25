import { Global, Module } from '@nestjs/common';
import {
  METRICS_SOURCES_PORT,
  type BackofficeMetrics,
  type MetricsSourcesPort,
} from '../modules/backoffice/index.js';
import {
  CATALOG_METRICS,
  CatalogModule,
  type CatalogMetricsQuery,
} from '../modules/catalog/index.js';
import {
  NOTIFICATIONS_METRICS,
  NotificationsModule,
  type NotificationsMetricsQuery,
} from '../modules/notifications/index.js';
import { OrderingModule, OrderingService } from '../modules/ordering/index.js';
import {
  PAYMENTS_METRICS,
  PaymentsModule,
  type PaymentsMetricsQuery,
} from '../modules/payments/index.js';
import { OUTBOX_METRICS, type OutboxMetricsQuery } from '../shared/ports/outbox-metrics.js';

/** Collects each module's public aggregates; no SQL and no rules here. */
export class ModuleMetricsSources implements MetricsSourcesPort {
  constructor(
    private readonly ordering: OrderingService,
    private readonly catalog: CatalogMetricsQuery,
    private readonly payments: PaymentsMetricsQuery,
    private readonly notifications: NotificationsMetricsQuery,
    private readonly outbox: OutboxMetricsQuery,
  ) {}

  async collect(): Promise<BackofficeMetrics> {
    const [orders, lots, payments, deliveries, outbox] = await Promise.all([
      this.ordering.metrics(),
      this.catalog.lotsByStatus(),
      this.payments.snapshot(),
      this.notifications.deliveriesByStatus(),
      this.outbox.snapshot(),
    ]);
    return {
      ordersByStatus: orders.byStatus,
      paidOrdersTotalCop: orders.paidTotalCop,
      lotsByStatus: lots,
      payments,
      notificationDeliveries: deliveries,
      outbox,
    };
  }
}

@Global()
@Module({
  imports: [OrderingModule, CatalogModule, PaymentsModule, NotificationsModule],
  providers: [
    {
      provide: METRICS_SOURCES_PORT,
      inject: [
        OrderingService,
        CATALOG_METRICS,
        PAYMENTS_METRICS,
        NOTIFICATIONS_METRICS,
        OUTBOX_METRICS,
      ],
      useFactory: (
        ordering: OrderingService,
        catalog: CatalogMetricsQuery,
        payments: PaymentsMetricsQuery,
        notifications: NotificationsMetricsQuery,
        outbox: OutboxMetricsQuery,
      ) => new ModuleMetricsSources(ordering, catalog, payments, notifications, outbox),
    },
  ],
  exports: [METRICS_SOURCES_PORT],
})
export class BackofficeBridgeModule {}
