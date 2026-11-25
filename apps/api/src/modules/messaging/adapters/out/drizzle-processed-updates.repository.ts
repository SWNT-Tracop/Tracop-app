import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DatabaseService } from '../../../../shared/infra/database.js';
import type {
  ProcessedUpdatesRepository,
  ProcessedUpdatesRetentionRepository,
} from '../../ports/messaging-ports.js';
import { processedUpdates } from './drizzle-schema.js';

@Injectable()
export class DrizzleProcessedUpdatesRepository
  implements ProcessedUpdatesRepository, ProcessedUpdatesRetentionRepository
{
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async claim(updateId: bigint): Promise<boolean> {
    const rows = await this.database
      .current()
      .insert(processedUpdates)
      .values({ updateId })
      .onConflictDoNothing()
      .returning({ updateId: processedUpdates.updateId });
    return rows.length > 0;
  }

  async deleteReceivedBefore(cutoff: Date, limit: number): Promise<number> {
    const result = await this.database.current().execute(sql`
      DELETE FROM messaging.processed_updates
      WHERE update_id IN (
        SELECT update_id FROM messaging.processed_updates
        WHERE received_at < ${cutoff}
        LIMIT ${limit}
      )`);
    return Number((result as { rowCount?: number | null }).rowCount ?? 0);
  }
}
