import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DatabaseService } from '../../../../shared/infra/database.js';
import type { IdentityRetentionRepository } from '../../ports/identity-ports.js';

const rowCount = (result: unknown): number =>
  Number((result as { rowCount?: number | null }).rowCount ?? 0);

@Injectable()
export class DrizzleIdentityRetentionRepository implements IdentityRetentionRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async deleteOtpCodesExpiredBefore(cutoff: Date, limit: number): Promise<number> {
    return rowCount(
      await this.database.current().execute(sql`
        DELETE FROM identity.otp_codes
        WHERE id IN (
          SELECT id FROM identity.otp_codes WHERE expires_at < ${cutoff} LIMIT ${limit}
        )`),
    );
  }

  async deleteSessionsEndedBefore(cutoff: Date, limit: number): Promise<number> {
    return rowCount(
      await this.database.current().execute(sql`
        DELETE FROM identity.sessions
        WHERE id IN (
          SELECT id FROM identity.sessions
          WHERE expires_at < ${cutoff} OR revoked_at < ${cutoff}
          LIMIT ${limit}
        )`),
    );
  }

  async deleteRateLimitWindowsBefore(cutoff: Date, limit: number): Promise<number> {
    return rowCount(
      await this.database.current().execute(sql`
        DELETE FROM identity.rate_limit_counters
        WHERE key_hash IN (
          SELECT key_hash FROM identity.rate_limit_counters
          WHERE window_start < ${cutoff}
          LIMIT ${limit}
        )`),
    );
  }

  async expireUnverifiedBefore(
    cutoff: Date,
    limit: number,
    pseudonym: (userId: string, phone: string) => string,
    now: Date,
  ): Promise<number> {
    const { rows } = await this.database.current().execute(sql`
      SELECT id, phone FROM identity.users
      WHERE status = 'pending_verification' AND created_at < ${cutoff}
      ORDER BY created_at LIMIT ${limit}
      FOR UPDATE SKIP LOCKED`);
    let expired = 0;
    for (const row of rows as { id: string; phone: string }[]) {
      await this.database.current().execute(sql`
        UPDATE identity.users
        SET status = 'expired', phone = ${pseudonym(row.id, row.phone)}, full_name = '',
            updated_at = ${now}, deleted_at = ${now}
        WHERE id = ${row.id}::uuid AND status = 'pending_verification'`);
      await this.database.current().execute(sql`
        DELETE FROM identity.otp_codes WHERE user_id = ${row.id}::uuid`);
      expired += 1;
    }
    return expired;
  }
}
