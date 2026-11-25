import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DatabaseService } from '../../../../shared/infra/database.js';
import type { RateeKind, RatingProps } from '../../domain/rating.js';
import type {
  VerificationCheck,
  VerificationProps,
  VerificationStatus,
} from '../../domain/verification.js';
import type {
  CarrierDeliveryStats,
  ReputationTotals,
  TrustRepository,
} from '../../ports/trust-ports.js';

type Row = Record<string, unknown>;

const uuidList = (ids: readonly string[]) =>
  sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

const toRating = (row: Row): RatingProps => ({
  id: String(row.id),
  orderId: String(row.order_id),
  raterId: String(row.rater_id),
  rateeId: String(row.ratee_id),
  rateeKind: row.ratee_kind as RateeKind,
  score: Number(row.score),
  comment: (row.comment as string | null) ?? null,
  createdAt: new Date(row.created_at as string),
  hiddenAt: row.hidden_at ? new Date(row.hidden_at as string) : null,
});

const toVerification = (row: Row): VerificationProps => ({
  providerId: String(row.provider_id),
  status: row.status as VerificationStatus,
  note: (row.note as string | null) ?? null,
  checks: (row.checks as Record<VerificationCheck, boolean> | null) ?? null,
  reason: (row.reason as string | null) ?? null,
  requestedAt: row.requested_at ? new Date(row.requested_at as string) : null,
  reviewedBy: (row.reviewed_by as string | null) ?? null,
  reviewedAt: row.reviewed_at ? new Date(row.reviewed_at as string) : null,
  version: Number(row.version),
});

@Injectable()
export class DrizzleTrustRepository implements TrustRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  private async rows(query: ReturnType<typeof sql>): Promise<Row[]> {
    return (await this.database.current().execute(query)).rows as Row[];
  }

  async findRating(id: string): Promise<RatingProps | null> {
    const [row] = await this.rows(sql`SELECT * FROM trust.ratings WHERE id = ${id}::uuid`);
    return row ? toRating(row) : null;
  }

  async insertRating(rating: RatingProps): Promise<boolean> {
    const inserted = await this.rows(sql`
      INSERT INTO trust.ratings (id, order_id, rater_id, ratee_id, ratee_kind, score, comment, created_at)
      VALUES (${rating.id}::uuid, ${rating.orderId}::uuid, ${rating.raterId}::uuid, ${rating.rateeId}::uuid,
        ${rating.rateeKind}, ${rating.score}, ${rating.comment}, ${rating.createdAt})
      ON CONFLICT DO NOTHING
      RETURNING id
    `);
    return inserted.length === 1;
  }

  async addToReputation(
    subjectId: string,
    kind: RateeKind,
    score: number,
    now: Date,
  ): Promise<void> {
    await this.database.current().execute(sql`
      INSERT INTO trust.reputations (subject_id, subject_kind, rating_sum, ratings_count, updated_at)
      VALUES (${subjectId}::uuid, ${kind}, ${score}, 1, ${now})
      ON CONFLICT (subject_id, subject_kind) DO UPDATE SET
        rating_sum = trust.reputations.rating_sum + EXCLUDED.rating_sum,
        ratings_count = trust.reputations.ratings_count + 1,
        updated_at = EXCLUDED.updated_at
    `);
  }

  async reputations(
    subjectIds: readonly string[],
    kind: RateeKind,
  ): Promise<ReadonlyMap<string, ReputationTotals>> {
    if (!subjectIds.length) return new Map();
    const rows = await this.rows(sql`
      SELECT subject_id, rating_sum::text AS rating_sum, ratings_count FROM trust.reputations
      WHERE subject_kind = ${kind} AND subject_id IN (${uuidList(subjectIds)})
    `);
    return new Map(
      rows.map((row) => [
        String(row.subject_id),
        {
          ratingSum: BigInt(String(row.rating_sum)),
          ratingsCount: BigInt(Number(row.ratings_count)),
        },
      ]),
    );
  }

  async visibleComments(subjectId: string, kind: RateeKind): Promise<readonly RatingProps[]> {
    return (
      await this.rows(sql`
        SELECT * FROM trust.ratings
        WHERE ratee_id = ${subjectId}::uuid AND ratee_kind = ${kind}
          AND comment IS NOT NULL AND hidden_at IS NULL
      `)
    ).map(toRating);
  }

  async ratingsOf(subjectId: string): Promise<readonly RatingProps[]> {
    return (
      await this.rows(sql`
        SELECT * FROM trust.ratings WHERE ratee_id = ${subjectId}::uuid ORDER BY created_at, id
      `)
    ).map(toRating);
  }

  async hideComment(id: string, staffId: string, now: Date): Promise<RatingProps | null> {
    await this.database.current().execute(sql`
      UPDATE trust.ratings SET hidden_at = ${now}, hidden_by = ${staffId}::uuid
      WHERE id = ${id}::uuid AND hidden_at IS NULL AND comment IS NOT NULL
    `);
    return this.findRating(id);
  }

  async countDelivery(
    orderId: string,
    carrierId: string,
    withWindow: boolean,
    onTime: boolean,
    now: Date,
  ): Promise<boolean> {
    const counted = await this.rows(sql`
      INSERT INTO trust.counted_deliveries (order_id, counted_at) VALUES (${orderId}::uuid, ${now})
      ON CONFLICT DO NOTHING RETURNING order_id
    `);
    if (!counted.length) return false;
    await this.database.current().execute(sql`
      INSERT INTO trust.carrier_delivery_stats
        (carrier_id, delivered_count, with_window_count, on_time_count, updated_at)
      VALUES (${carrierId}::uuid, 1, ${withWindow ? 1 : 0}, ${onTime ? 1 : 0}, ${now})
      ON CONFLICT (carrier_id) DO UPDATE SET
        delivered_count = trust.carrier_delivery_stats.delivered_count + 1,
        with_window_count = trust.carrier_delivery_stats.with_window_count + EXCLUDED.with_window_count,
        on_time_count = trust.carrier_delivery_stats.on_time_count + EXCLUDED.on_time_count,
        updated_at = EXCLUDED.updated_at
    `);
    return true;
  }

  async carrierStats(carrierId: string): Promise<CarrierDeliveryStats | null> {
    const [row] = await this.rows(
      sql`SELECT * FROM trust.carrier_delivery_stats WHERE carrier_id = ${carrierId}::uuid`,
    );
    return row
      ? {
          deliveredCount: Number(row.delivered_count),
          withWindowCount: Number(row.with_window_count),
          onTimeCount: Number(row.on_time_count),
        }
      : null;
  }

  async findVerification(providerId: string, lock = false): Promise<VerificationProps | null> {
    // A provider without a row has never asked; the advisory lock serializes the first request.
    if (lock)
      await this.database
        .current()
        .execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${`trust.verification:${providerId}`}))`,
        );
    const [row] = await this.rows(
      sql`SELECT * FROM trust.verifications WHERE provider_id = ${providerId}::uuid`,
    );
    return row ? toVerification(row) : null;
  }

  async saveVerification(verification: VerificationProps): Promise<void> {
    await this.database.current().execute(sql`
      INSERT INTO trust.verifications
        (provider_id, status, note, checks, reason, requested_at, reviewed_by, reviewed_at, version)
      VALUES (${verification.providerId}::uuid, ${verification.status}, ${verification.note},
        ${verification.checks ? JSON.stringify(verification.checks) : null}::jsonb, ${verification.reason},
        ${verification.requestedAt}, ${verification.reviewedBy}, ${verification.reviewedAt},
        ${verification.version})
      ON CONFLICT (provider_id) DO UPDATE SET
        status = EXCLUDED.status, note = EXCLUDED.note, checks = EXCLUDED.checks,
        reason = EXCLUDED.reason, requested_at = EXCLUDED.requested_at,
        reviewed_by = EXCLUDED.reviewed_by, reviewed_at = EXCLUDED.reviewed_at,
        version = EXCLUDED.version
    `);
  }

  async verifiedProviders(providerIds: readonly string[]): Promise<ReadonlySet<string>> {
    if (!providerIds.length) return new Set();
    const rows = await this.rows(sql`
      SELECT provider_id FROM trust.verifications
      WHERE status = 'verified' AND provider_id IN (${uuidList(providerIds)})
    `);
    return new Set(rows.map((row) => String(row.provider_id)));
  }

  async listVerifications(
    status: VerificationStatus,
    limit: number,
  ): Promise<readonly VerificationProps[]> {
    return (
      await this.rows(sql`
        SELECT * FROM trust.verifications WHERE status = ${status}
        ORDER BY requested_at NULLS LAST, provider_id LIMIT ${limit}
      `)
    ).map(toVerification);
  }
}
