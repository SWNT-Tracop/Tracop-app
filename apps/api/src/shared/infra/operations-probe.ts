import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { OperationsProbe } from '../ports/operations.js';
import { DatabaseService } from './database.js';

@Injectable()
export class PostgresOperationsProbe implements OperationsProbe {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async databaseReachable(): Promise<boolean> {
    try {
      await this.database.db.execute(sql`SELECT 1`);
      return true;
    } catch {
      return false;
    }
  }

  async latestHeartbeat(): Promise<Date | null> {
    const { rows } = await this.database.db.execute(
      sql`SELECT max(beat_at) AS beat_at FROM shared.worker_heartbeats`,
    );
    const value = (rows[0] as { beat_at: string | Date | null } | undefined)?.beat_at;
    return value ? new Date(value) : null;
  }

  async beat(workerId: string, at: Date): Promise<void> {
    await this.database.db.execute(sql`
      INSERT INTO shared.worker_heartbeats (worker_id, beat_at) VALUES (${workerId}, ${at})
      ON CONFLICT (worker_id) DO UPDATE SET beat_at = EXCLUDED.beat_at`);
  }
}
