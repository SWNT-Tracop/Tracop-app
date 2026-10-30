import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DatabaseService } from './database.js';
import { OUTBOX_WRITER } from './tokens.js';
import type { OutboxEventInput, OutboxWriter } from '../ports/outbox-writer.js';
import { createId } from '../kernel/ids.js';

@Injectable()
export class DrizzleOutboxWriter implements OutboxWriter {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async append(events: readonly OutboxEventInput[]): Promise<void> {
    if (events.length === 0) return;
    const db = this.database.current();
    for (const event of events) {
      await db.execute(sql`INSERT INTO shared.outbox_events (id, aggregate, type, payload, created_at)
        VALUES (${createId()}::uuid, ${event.aggregate}, ${event.type}, ${JSON.stringify(event.payload)}::jsonb, now())`);
    }
  }
}

export const outboxWriterProvider = { provide: OUTBOX_WRITER, useExisting: DrizzleOutboxWriter };
