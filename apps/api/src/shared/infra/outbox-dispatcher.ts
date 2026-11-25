import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import type pino from 'pino';
import type { Clock } from '../kernel/clock.js';
import { createId } from '../kernel/ids.js';
import type {
  OutboxDispatchResult,
  OutboxDispatcher,
  OutboxDispatcherSettings,
} from '../ports/outbox-dispatcher.js';
import { OUTBOX_DISPATCHER_SETTINGS } from '../ports/outbox-dispatcher.js';
import {
  OUTBOX_SUBSCRIBERS,
  type OutboxEventRecord,
  type OutboxSubscriberPort,
} from '../ports/outbox-subscriber.js';
import { APP_CLOCK, APP_LOGGER, DATABASE_POOL } from './tokens.js';

/** Exponential backoff for the n-th failed attempt (1-based), capped. */
export const outboxRetryDelaySeconds = (
  attempt: number,
  settings: Pick<OutboxDispatcherSettings, 'retryBaseSeconds' | 'retryMaxSeconds'>,
): number =>
  Math.min(settings.retryMaxSeconds, settings.retryBaseSeconds * 2 ** Math.max(0, attempt - 1));

const errorName = (error: unknown): string =>
  error instanceof Error && error.name ? error.name : 'UnknownSubscriberError';

interface ClaimedRow {
  id: string;
  aggregate: string;
  type: string;
  payload: Record<string, unknown>;
  created_at: Date;
  attempts: number;
}

/**
 * Delivers outbox events to subscribers without holding a transaction while a subscriber runs.
 *
 * 1. Claim: one statement leases due events with FOR UPDATE SKIP LOCKED, so concurrent
 *    dispatchers never claim the same event.
 * 2. Deliver: each matching consumer runs outside any transaction; its success is recorded in
 *    shared.outbox_deliveries, so a retry skips consumers that already succeeded.
 * 3. Settle: the event is published, or rescheduled with backoff, or dead-lettered after the
 *    last attempt; only the holder of the lease may settle it.
 */
@Injectable()
export class PostgresOutboxDispatcher implements OutboxDispatcher {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: pg.Pool,
    @Inject(APP_CLOCK) private readonly clock: Clock,
    @Inject(APP_LOGGER) private readonly logger: pino.Logger,
    @Inject(OUTBOX_DISPATCHER_SETTINGS) private readonly settings: OutboxDispatcherSettings,
    @Inject(OUTBOX_SUBSCRIBERS) private readonly subscribers: readonly OutboxSubscriberPort[],
  ) {
    const names = subscribers.map((subscriber) => subscriber.consumer);
    if (new Set(names).size !== names.length)
      throw new Error('Outbox consumer names must be unique.');
  }

  async dispatch(batchSize = 50): Promise<OutboxDispatchResult> {
    const result = { claimed: 0, published: 0, retried: 0, deadLettered: 0 };
    if (this.subscribers.length === 0) return result;
    const leaseToken = createId();
    const claimed = await this.claim(leaseToken, batchSize);
    result.claimed = claimed.length;
    for (const event of claimed) {
      const outcome = await this.deliver(event, leaseToken);
      result[outcome] += 1;
    }
    return result;
  }

  private async claim(leaseToken: string, batchSize: number): Promise<OutboxEventRecord[]> {
    const now = this.clock.now();
    const leaseUntil = new Date(now.getTime() + this.settings.leaseSeconds * 1000);
    const { rows } = await this.pool.query<ClaimedRow>(
      `UPDATE shared.outbox_events AS event
       SET locked_until = $2, lease_token = $3
       FROM (
         SELECT id FROM shared.outbox_events
         WHERE published_at IS NULL
           AND failed_at IS NULL
           AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
           AND (locked_until IS NULL OR locked_until <= $1)
         ORDER BY created_at, id
         LIMIT $4
         FOR UPDATE SKIP LOCKED
       ) AS due
       WHERE event.id = due.id
       RETURNING event.id, event.aggregate, event.type, event.payload, event.created_at,
                 event.attempts`,
      [now, leaseUntil, leaseToken, batchSize],
    );
    return rows
      .map((row) => ({
        id: row.id,
        aggregate: row.aggregate,
        type: row.type,
        payload: row.payload,
        createdAt: row.created_at,
        attempts: row.attempts,
      }))
      .sort(
        (left, right) =>
          left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id),
      );
  }

  private async deliver(
    event: OutboxEventRecord,
    leaseToken: string,
  ): Promise<'published' | 'retried' | 'deadLettered'> {
    const delivered = new Set(
      (
        await this.pool.query<{ consumer: string }>(
          `SELECT consumer FROM shared.outbox_deliveries WHERE event_id = $1`,
          [event.id],
        )
      ).rows.map((row) => row.consumer),
    );
    const pending = this.subscribers.filter(
      (subscriber) =>
        !delivered.has(subscriber.consumer) &&
        (subscriber.eventTypes === '*' || subscriber.eventTypes.includes(event.type)),
    );

    const failures: string[] = [];
    for (const subscriber of pending) {
      try {
        await subscriber.handle(event);
        await this.pool.query(
          `INSERT INTO shared.outbox_deliveries (consumer, event_id, delivered_at)
           VALUES ($1, $2, $3)
           ON CONFLICT (consumer, event_id) DO NOTHING`,
          [subscriber.consumer, event.id, this.clock.now()],
        );
      } catch (error) {
        failures.push(errorName(error));
        this.logger.error(
          {
            event: 'outbox_delivery_failed',
            eventType: event.type,
            consumer: subscriber.consumer,
            attempt: event.attempts + 1,
            errorName: errorName(error),
          },
          'Outbox delivery failed.',
        );
      }
    }
    return failures.length === 0
      ? this.markPublished(event, leaseToken)
      : this.scheduleRetry(event, leaseToken, failures);
  }

  private async markPublished(event: OutboxEventRecord, leaseToken: string): Promise<'published'> {
    await this.pool.query(
      `UPDATE shared.outbox_events
       SET published_at = $3, locked_until = NULL, lease_token = NULL
       WHERE id = $1 AND lease_token = $2`,
      [event.id, leaseToken, this.clock.now()],
    );
    return 'published';
  }

  private async scheduleRetry(
    event: OutboxEventRecord,
    leaseToken: string,
    failures: readonly string[],
  ): Promise<'retried' | 'deadLettered'> {
    const now = this.clock.now();
    const attempts = event.attempts + 1;
    const deadLetter = attempts >= this.settings.maxAttempts;
    const nextAttemptAt = new Date(
      now.getTime() + outboxRetryDelaySeconds(attempts, this.settings) * 1000,
    );
    await this.pool.query(
      `UPDATE shared.outbox_events
       SET attempts = $3,
           next_attempt_at = $4,
           failed_at = $5,
           last_error = $6,
           locked_until = NULL,
           lease_token = NULL
       WHERE id = $1 AND lease_token = $2`,
      [
        event.id,
        leaseToken,
        attempts,
        deadLetter ? null : nextAttemptAt,
        deadLetter ? now : null,
        [...new Set(failures)].join(',').slice(0, 500),
      ],
    );
    if (deadLetter)
      this.logger.error(
        { event: 'outbox_event_dead_lettered', eventType: event.type, attempts },
        'Outbox event moved to dead letter.',
      );
    return deadLetter ? 'deadLettered' : 'retried';
  }
}
