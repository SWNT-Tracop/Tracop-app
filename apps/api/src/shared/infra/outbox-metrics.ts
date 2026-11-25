import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { OutboxMetricsQuery } from '../ports/outbox-metrics.js';
import { DatabaseService } from './database.js';

@Injectable()
export class PostgresOutboxMetricsQuery implements OutboxMetricsQuery {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async snapshot(): Promise<{ readonly pending: number; readonly deadLettered: number }> {
    const result = await this.database.current().execute(sql`
      SELECT
        count(*) FILTER (WHERE published_at IS NULL AND failed_at IS NULL)::int AS pending,
        count(*) FILTER (WHERE failed_at IS NOT NULL)::int AS dead_lettered
      FROM shared.outbox_events
    `);
    const row = result.rows[0] as { pending: number; dead_lettered: number };
    return { pending: row.pending, deadLettered: row.dead_lettered };
  }
}
