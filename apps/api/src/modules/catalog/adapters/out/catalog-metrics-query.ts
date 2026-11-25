import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DatabaseService } from '../../../../shared/infra/database.js';
import { LOT_STATES } from '../../domain/lot.js';
import type { CatalogMetricsQuery } from '../../ports/catalog-ports.js';

@Injectable()
export class DrizzleCatalogMetricsQuery implements CatalogMetricsQuery {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async lotsByStatus(): Promise<Readonly<Record<string, number>>> {
    const result = await this.database.current().execute(sql`
      SELECT status, count(*)::int AS count FROM catalog.lots
      WHERE deleted_at IS NULL GROUP BY status
    `);
    const counts: Record<string, number> = Object.fromEntries(LOT_STATES.map((s) => [s, 0]));
    for (const row of result.rows as { status: string; count: number }[])
      counts[row.status] = row.count;
    return counts;
  }
}
