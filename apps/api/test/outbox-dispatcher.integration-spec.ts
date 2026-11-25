import { Test } from '@nestjs/testing';
import type { INestApplicationContext } from '@nestjs/common';
import pg from 'pg';
import pino from 'pino';
import { SharedInfraModule } from '../src/shared/infra/shared-infra.module.js';
import { DATABASE_POOL } from '../src/shared/infra/tokens.js';
import {
  PostgresOutboxDispatcher,
  outboxRetryDelaySeconds,
} from '../src/shared/infra/outbox-dispatcher.js';
import type { OutboxDispatcherSettings } from '../src/shared/ports/outbox-dispatcher.js';
import type {
  OutboxEventRecord,
  OutboxSubscriberPort,
} from '../src/shared/ports/outbox-subscriber.js';
import { createId } from '../src/shared/kernel/ids.js';
import { describePostgres, resetPostgresFixtures } from './postgres-suite.js';

// 20 iterations against PostgreSQL exceed Jest's 5 s default on a loaded machine; a timed-out
// test keeps running in the background and corrupts the next one, so give it room.
const CONCURRENCY_TEST_TIMEOUT_MS = 120_000;

const settings: OutboxDispatcherSettings = {
  leaseSeconds: 60,
  maxAttempts: 5,
  retryBaseSeconds: 5,
  retryMaxSeconds: 300,
};

class TestClock {
  constructor(private current: Date) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(seconds: number): void {
    this.current = new Date(this.current.getTime() + seconds * 1000);
  }
}

class RecordingSubscriber implements OutboxSubscriberPort {
  readonly calls: string[] = [];
  failuresLeft: number;
  constructor(
    readonly consumer: string,
    readonly eventTypes: readonly string[] | '*',
    options: { failures?: number; delayMs?: number } = {},
  ) {
    this.failuresLeft = options.failures ?? 0;
    this.delayMs = options.delayMs ?? 0;
  }
  private readonly delayMs: number;
  async handle(event: OutboxEventRecord): Promise<void> {
    this.calls.push(event.id);
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      throw new TypeError('synthetic failure');
    }
  }
}

describePostgres('outbox dispatcher (PostgreSQL)', () => {
  const start = new Date('2026-11-20T12:00:00.000Z');
  const logger = pino({ level: 'silent' });
  let app: INestApplicationContext;
  let pool: pg.Pool;

  const dispatcher = (clock: TestClock, subscribers: readonly OutboxSubscriberPort[]) =>
    new PostgresOutboxDispatcher(pool, clock, logger, settings, subscribers);

  const insertEvents = async (type: string, count: number): Promise<string[]> => {
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const id = createId();
      ids.push(id);
      await pool.query(
        `INSERT INTO shared.outbox_events (id, aggregate, type, payload, created_at)
         VALUES ($1, $2, $3, '{}'::jsonb, $4)`,
        [id, `agg:${index % 3}`, type, new Date(start.getTime() + index)],
      );
    }
    return ids;
  };

  const eventState = async (id: string) =>
    (
      await pool.query<{
        published_at: Date | null;
        failed_at: Date | null;
        attempts: number;
        next_attempt_at: Date | null;
        last_error: string | null;
        lease_token: string | null;
      }>(
        `SELECT published_at, failed_at, attempts, next_attempt_at, last_error, lease_token
         FROM shared.outbox_events WHERE id = $1`,
        [id],
      )
    ).rows[0]!;

  beforeAll(async () => {
    app = await Test.createTestingModule({ imports: [SharedInfraModule] }).compile();
    pool = app.get(DATABASE_POOL) as pg.Pool;
  });
  beforeEach(async () => resetPostgresFixtures(pool));
  afterAll(async () => app.close());

  it('delivers each event once to every matching consumer and marks it published', async () => {
    const clock = new TestClock(start);
    const orders = new RecordingSubscriber('notifications.orders', ['OrderAccepted']);
    const audit = new RecordingSubscriber('audit.all', '*');
    const [accepted] = await insertEvents('OrderAccepted', 1);
    const [other] = await insertEvents('LotPublished', 1);

    const result = await dispatcher(clock, [orders, audit]).dispatch();
    expect(result).toEqual({ claimed: 2, published: 2, retried: 0, deadLettered: 0 });
    expect(orders.calls).toEqual([accepted]);
    expect([...audit.calls].sort()).toEqual([accepted, other].sort());
    expect((await eventState(accepted!)).published_at).toEqual(start);
    const deliveries = await pool.query(
      `SELECT consumer, event_id FROM shared.outbox_deliveries ORDER BY consumer, event_id`,
    );
    expect(deliveries.rowCount).toBe(3);
    expect(await dispatcher(clock, [orders, audit]).dispatch()).toMatchObject({ claimed: 0 });
  });

  it(
    'never delivers an event twice when two dispatchers run in parallel',
    async () => {
      for (let iteration = 0; iteration < 20; iteration += 1) {
        await resetPostgresFixtures(pool);
        const clock = new TestClock(start);
        const subscriber = new RecordingSubscriber('notifications.orders', '*', { delayMs: 1 });
        const ids = await insertEvents('OrderAccepted', 30);
        const [first, second] = await Promise.all([
          dispatcher(clock, [subscriber]).dispatch(20),
          dispatcher(clock, [subscriber]).dispatch(20),
        ]);
        expect({ iteration, claimed: first.claimed + second.claimed }).toEqual({
          iteration,
          claimed: 30,
        });
        expect({ iteration, calls: [...subscriber.calls].sort() }).toEqual({
          iteration,
          calls: [...ids].sort(),
        });
      }
    },
    CONCURRENCY_TEST_TIMEOUT_MS,
  );

  it('retries with exponential backoff and dead-letters after the last attempt', async () => {
    const clock = new TestClock(start);
    const failing = new RecordingSubscriber('notifications.orders', '*', { failures: 99 });
    const [id] = await insertEvents('OrderAccepted', 1);
    const run = () => dispatcher(clock, [failing]).dispatch();

    for (let attempt = 1; attempt < settings.maxAttempts; attempt += 1) {
      expect(await run()).toMatchObject({ claimed: 1, retried: 1 });
      const state = await eventState(id!);
      const delay = outboxRetryDelaySeconds(attempt, settings);
      expect(state).toMatchObject({
        attempts: attempt,
        failed_at: null,
        published_at: null,
        lease_token: null,
        last_error: 'TypeError',
        next_attempt_at: new Date(clock.now().getTime() + delay * 1000),
      });
      expect(await run()).toMatchObject({ claimed: 0 });
      clock.advance(delay);
    }
    expect(await run()).toMatchObject({ claimed: 1, deadLettered: 1 });
    expect(await eventState(id!)).toMatchObject({
      attempts: settings.maxAttempts,
      failed_at: clock.now(),
      next_attempt_at: null,
      published_at: null,
    });
    clock.advance(86_400);
    expect(await run()).toMatchObject({ claimed: 0 });
    expect(failing.calls.length).toBe(settings.maxAttempts);
    expect(
      [5, 10, 20, 40, 80, 160, 300, 300].map((_, i) => outboxRetryDelaySeconds(i + 1, settings)),
    ).toEqual([5, 10, 20, 40, 80, 160, 300, 300]);
  });

  it('does not let a failing consumer block other consumers or other events', async () => {
    const clock = new TestClock(start);
    const healthy = new RecordingSubscriber('audit.all', '*');
    const failing = new RecordingSubscriber('notifications.orders', ['OrderAccepted'], {
      failures: 1,
    });
    const [accepted] = await insertEvents('OrderAccepted', 1);
    const [published] = await insertEvents('LotPublished', 1);

    expect(await dispatcher(clock, [healthy, failing]).dispatch()).toMatchObject({
      claimed: 2,
      published: 1,
      retried: 1,
    });
    expect((await eventState(published!)).published_at).toEqual(start);
    expect([...healthy.calls].sort()).toEqual([accepted, published].sort());

    clock.advance(outboxRetryDelaySeconds(1, settings));
    expect(await dispatcher(clock, [healthy, failing]).dispatch()).toMatchObject({
      claimed: 1,
      published: 1,
    });
    // The healthy consumer already succeeded for this event, so the retry skips it.
    expect(healthy.calls.filter((call) => call === accepted)).toHaveLength(1);
    expect(failing.calls).toEqual([accepted, accepted]);
  });

  it('skips events leased by another dispatcher until the lease expires', async () => {
    const clock = new TestClock(start);
    const subscriber = new RecordingSubscriber('audit.all', '*');
    const [id] = await insertEvents('OrderAccepted', 1);
    // Simulates a dispatcher that claimed the event and crashed before settling it.
    await pool.query(
      `UPDATE shared.outbox_events SET locked_until = $2, lease_token = $3 WHERE id = $1`,
      [id, new Date(start.getTime() + settings.leaseSeconds * 1000), createId()],
    );
    expect(await dispatcher(clock, [subscriber]).dispatch()).toMatchObject({ claimed: 0 });
    clock.advance(settings.leaseSeconds);
    expect(await dispatcher(clock, [subscriber]).dispatch()).toMatchObject({
      claimed: 1,
      published: 1,
    });
  });

  it('claims nothing without subscribers and rejects duplicate consumer names', async () => {
    const clock = new TestClock(start);
    await insertEvents('OrderAccepted', 1);
    expect(await dispatcher(clock, []).dispatch()).toEqual({
      claimed: 0,
      published: 0,
      retried: 0,
      deadLettered: 0,
    });
    expect(() =>
      dispatcher(clock, [
        new RecordingSubscriber('same', '*'),
        new RecordingSubscriber('same', ['X']),
      ]),
    ).toThrow('unique');
  });
});
