import type { Clock } from '../../../shared/kernel/clock.js';
import type {
  MessagingMaintenanceApi,
  ProcessedUpdatesRetentionRepository,
} from '../ports/messaging-ports.js';

const DAY_MS = 86_400_000;
const BATCH_SIZE = 1000;
const MAX_BATCHES = 100;

/**
 * Telegram keeps undelivered updates for at most 24 hours, so an update id older than the
 * retention can no longer arrive again and its idempotency row is safe to delete.
 */
export class MessagingMaintenanceService implements MessagingMaintenanceApi {
  constructor(
    private readonly retention: ProcessedUpdatesRetentionRepository,
    private readonly clock: Clock,
    /** PROVISIONAL: days a processed update id is kept; must stay above 1. */
    private readonly retentionDays: number,
  ) {}

  async purgeProcessedUpdates(): Promise<number> {
    const cutoff = new Date(this.clock.now().getTime() - this.retentionDays * DAY_MS);
    let total = 0;
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const deleted = await this.retention.deleteReceivedBefore(cutoff, BATCH_SIZE);
      total += deleted;
      if (deleted < BATCH_SIZE) break;
    }
    return total;
  }
}
