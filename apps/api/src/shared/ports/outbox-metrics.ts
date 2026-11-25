/** Outbox health for the backoffice: events waiting and events given up on (dead letter). */
export interface OutboxMetricsQuery {
  snapshot(): Promise<{ readonly pending: number; readonly deadLettered: number }>;
}

export const OUTBOX_METRICS = Symbol('OUTBOX_METRICS');
