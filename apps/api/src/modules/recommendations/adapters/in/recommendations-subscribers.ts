import type {
  OutboxEventRecord,
  OutboxSubscriberPort,
} from '../../../../shared/ports/outbox-subscriber.js';
import type { RecommendationsService } from '../../application/recommendations-service.js';

const LOT_AGGREGATE = /^lot:([0-9a-f-]{36})$/i;
const ORDER_AGGREGATE = /^order:([0-9a-f-]{36})$/i;

/** LotPublished → price alerts; idempotent per (alert, lot). */
export class LotAlertsSubscriber implements OutboxSubscriberPort {
  readonly consumer = 'recommendations.lot-alerts';
  readonly eventTypes = ['LotPublished'] as const;

  constructor(private readonly service: Pick<RecommendationsService, 'matchAlerts'>) {}

  async handle(event: OutboxEventRecord): Promise<void> {
    const lotId = LOT_AGGREGATE.exec(event.aggregate)?.[1];
    if (lotId) await this.service.matchAlerts(lotId);
  }
}

/** OrderAccepted and OrderDelivered → price observations and the buyer's own history, once. */
export class OrderObservationsSubscriber implements OutboxSubscriberPort {
  readonly consumer = 'recommendations.price-observations';
  readonly eventTypes = ['OrderAccepted', 'OrderDelivered'] as const;

  constructor(
    private readonly service: Pick<
      RecommendationsService,
      'recordAcceptedOrder' | 'recordDeliveredOrder'
    >,
  ) {}

  async handle(event: OutboxEventRecord): Promise<void> {
    const orderId = ORDER_AGGREGATE.exec(event.aggregate)?.[1];
    if (!orderId) return;
    if (event.type === 'OrderAccepted') await this.service.recordAcceptedOrder(orderId);
    else await this.service.recordDeliveredOrder(orderId);
  }
}
