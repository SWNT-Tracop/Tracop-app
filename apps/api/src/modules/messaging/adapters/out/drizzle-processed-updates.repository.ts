import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../../../shared/infra/database.js';
import type { ProcessedUpdatesRepository } from '../../ports/messaging-ports.js';
import { processedUpdates } from './drizzle-schema.js';

@Injectable()
export class DrizzleProcessedUpdatesRepository implements ProcessedUpdatesRepository {
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
}
