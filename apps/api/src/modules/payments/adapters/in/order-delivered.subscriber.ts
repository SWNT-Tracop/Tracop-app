import type {
  OutboxEventRecord,
  OutboxSubscriberPort,
} from '../../../../shared/ports/outbox-subscriber.js';
import type { PaymentsService } from '../../application/payments-service.js';

const ORDER_AGGREGATE = /^order:([0-9a-f-]{36})$/i;

/**
 * OrderDelivered -> the verified payment of the order is held for the claim window. The use case
 * is idempotent (a payment already held is left alone), as at-least-once delivery requires.
 */
export class OrderDeliveredSubscriber implements OutboxSubscriberPort {
  readonly consumer = 'payments.hold-on-delivery';
  readonly eventTypes = ['OrderDelivered'] as const;

  constructor(private readonly payments: Pick<PaymentsService, 'holdForDeliveredOrder'>) {}

  async handle(event: OutboxEventRecord): Promise<void> {
    const orderId = ORDER_AGGREGATE.exec(event.aggregate)?.[1];
    if (!orderId) return;
    await this.payments.holdForDeliveredOrder(orderId);
  }
}
