export interface OutboxEventRecord {
  readonly id: string;
  readonly aggregate: string;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
  readonly attempts: number;
}

/**
 * A consumer of outbox events. Delivery is at least once: a consumer may see the same event
 * again after a crash or an expired lease, so `handle` must be idempotent by `event.id`.
 */
export interface OutboxSubscriberPort {
  /** Unique, stable name; it is the idempotency key in shared.outbox_deliveries. */
  readonly consumer: string;
  /** Event types this consumer wants, or '*' for every event. */
  readonly eventTypes: readonly string[] | '*';
  handle(event: OutboxEventRecord): Promise<void>;
}

export const OUTBOX_SUBSCRIBERS = Symbol('OUTBOX_SUBSCRIBERS');
