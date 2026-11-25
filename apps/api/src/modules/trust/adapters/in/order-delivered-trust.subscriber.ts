import type {
  OutboxEventRecord,
  OutboxSubscriberPort,
} from '../../../../shared/ports/outbox-subscriber.js';
import type { TrustService } from '../../application/trust-service.js';

const ORDER_AGGREGATE = /^order:([0-9a-f-]{36})$/i;

/** OrderDelivered → the carrier's internal delivery counts; each order counts once. */
export class OrderDeliveredTrustSubscriber implements OutboxSubscriberPort {
  readonly consumer = 'trust.delivery-stats';
  readonly eventTypes = ['OrderDelivered'] as const;

  constructor(private readonly trust: Pick<TrustService, 'countDelivery'>) {}

  async handle(event: OutboxEventRecord): Promise<void> {
    const orderId = ORDER_AGGREGATE.exec(event.aggregate)?.[1];
    if (orderId) await this.trust.countDelivery(orderId);
  }
}
