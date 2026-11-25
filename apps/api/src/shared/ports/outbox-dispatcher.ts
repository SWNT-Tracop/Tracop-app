export interface OutboxDispatchResult {
  /** Events claimed in this run. */
  readonly claimed: number;
  /** Events delivered to every matching consumer and marked published. */
  readonly published: number;
  /** Events with at least one failed consumer, scheduled for retry. */
  readonly retried: number;
  /** Events that reached the attempt limit and were moved to the dead letter state. */
  readonly deadLettered: number;
}

export interface OutboxDispatcher {
  dispatch(batchSize?: number): Promise<OutboxDispatchResult>;
}

export interface OutboxDispatcherSettings {
  readonly leaseSeconds: number;
  readonly maxAttempts: number;
  readonly retryBaseSeconds: number;
  readonly retryMaxSeconds: number;
}

export const OUTBOX_DISPATCHER = Symbol('OUTBOX_DISPATCHER');
export const OUTBOX_DISPATCHER_SETTINGS = Symbol('OUTBOX_DISPATCHER_SETTINGS');
