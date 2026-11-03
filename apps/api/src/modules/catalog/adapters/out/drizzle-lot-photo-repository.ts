import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import type { LotPhotoProps, LotPhotoState } from '../../domain/lot-photo.js';
import type { LotPhotoRepository, LotPhotoReservation } from '../../ports/lot-photo-ports.js';
import { DATABASE_POOL } from '../../../../shared/infra/tokens.js';

type PhotoRow = {
  id: string;
  lot_id: string;
  media_ref: string;
  state: LotPhotoState;
  content_type: 'image/webp' | null;
  size_bytes: number | null;
  position: number;
  created_at: Date;
  expires_at: Date;
  lease_token: string | null;
  lease_expires_at: Date | null;
  deleted_at: Date | null;
};

const toPhoto = (row: PhotoRow): LotPhotoProps => ({
  id: row.id,
  lotId: row.lot_id,
  mediaRef: row.media_ref,
  state: row.state,
  contentType: row.content_type,
  sizeBytes: row.size_bytes,
  position: row.position,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  leaseToken: row.lease_token,
  leaseExpiresAt: row.lease_expires_at,
  deletedAt: row.deleted_at,
});

@Injectable()
export class DrizzleLotPhotoRepository implements LotPhotoRepository {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  async reserveUpload(input: {
    readonly lotId: string;
    readonly photoId: string;
    readonly ownerId: string;
    readonly incomingKey: string;
    readonly now: Date;
    readonly expiresAt: Date;
    readonly maxCount: number;
  }): Promise<LotPhotoReservation> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const lot = await client.query<{ provider_id: string; status: string }>(
        `SELECT provider_id, status FROM catalog.lots
         WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [input.lotId],
      );
      const ownerLot = lot.rows[0];
      if (!ownerLot) {
        await client.query('ROLLBACK');
        return { kind: 'not_found' };
      }
      if (ownerLot.provider_id !== input.ownerId) {
        await client.query('ROLLBACK');
        return { kind: 'conflict' };
      }
      if (ownerLot.status !== 'draft' && ownerLot.status !== 'published') {
        await client.query('ROLLBACK');
        return { kind: 'invalid_state' };
      }

      const existing = await client.query<PhotoRow>(
        'SELECT * FROM catalog.lot_photos WHERE id = $1',
        [input.photoId],
      );
      if (existing.rows[0]) {
        const photo = existing.rows[0];
        if (photo.lot_id !== input.lotId || photo.deleted_at) {
          await client.query('ROLLBACK');
          return { kind: 'conflict' };
        }
        if (photo.state === 'pending') {
          const extended = await client.query<PhotoRow>(
            `UPDATE catalog.lot_photos SET expires_at = $2
             WHERE id = $1 AND state = 'pending' AND deleted_at IS NULL RETURNING *`,
            [input.photoId, input.expiresAt],
          );
          await client.query('COMMIT');
          return { kind: 'pending', photo: toPhoto(extended.rows[0] ?? photo) };
        }
        await client.query('COMMIT');
        if (photo.state === 'processing') return { kind: 'processing', photo: toPhoto(photo) };
        if (photo.state === 'ready') return { kind: 'ready', photo: toPhoto(photo) };
        return { kind: 'conflict' };
      }

      const active = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM catalog.lot_photos
         WHERE lot_id = $1 AND deleted_at IS NULL
           AND (state IN ('processing','ready') OR (state = 'pending' AND expires_at > $2))`,
        [input.lotId, input.now],
      );
      if (Number(active.rows[0]?.count ?? 0) >= input.maxCount) {
        await client.query('ROLLBACK');
        return { kind: 'limit' };
      }
      const position = await client.query<{ position: number }>(
        `SELECT COALESCE(max(position), 0) + 1 AS position FROM catalog.lot_photos
         WHERE lot_id = $1 AND deleted_at IS NULL`,
        [input.lotId],
      );
      const inserted = await client.query<PhotoRow>(
        `INSERT INTO catalog.lot_photos
         (id, lot_id, media_ref, state, content_type, size_bytes, position, created_at, expires_at)
         VALUES ($1, $2, $3, 'pending', NULL, NULL, $4, $5, $6)
         ON CONFLICT (id) DO NOTHING RETURNING *`,
        [
          input.photoId,
          input.lotId,
          input.incomingKey,
          position.rows[0]?.position ?? 1,
          input.now,
          input.expiresAt,
        ],
      );
      if (!inserted.rows[0]) {
        await client.query('ROLLBACK');
        return { kind: 'conflict' };
      }
      await client.query('COMMIT');
      return { kind: 'created', photo: toPhoto(inserted.rows[0]) };
    } catch (error) {
      await safeRollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async findForOwner(
    lotId: string,
    photoId: string,
    ownerId: string,
  ): Promise<LotPhotoProps | null> {
    const result = await this.pool.query<PhotoRow>(
      `SELECT photos.* FROM catalog.lot_photos photos
       JOIN catalog.lots lots ON lots.id = photos.lot_id
       WHERE photos.lot_id = $1 AND photos.id = $2 AND lots.provider_id = $3
         AND photos.deleted_at IS NULL AND lots.deleted_at IS NULL`,
      [lotId, photoId, ownerId],
    );
    return result.rows[0] ? toPhoto(result.rows[0]) : null;
  }

  async claimConfirmation(
    photoId: string,
    now: Date,
    leaseToken: string,
    leaseExpiresAt: Date,
  ): Promise<LotPhotoProps | null> {
    const claimed = await this.pool.query<PhotoRow>(
      `UPDATE catalog.lot_photos
       SET state = 'processing', lease_token = $3, lease_expires_at = $4
       WHERE id = $1 AND state = 'pending' AND deleted_at IS NULL AND expires_at > $2
       RETURNING *`,
      [photoId, now, leaseToken, leaseExpiresAt],
    );
    if (claimed.rows[0]) return toPhoto(claimed.rows[0]);
    const reclaimed = await this.pool.query<PhotoRow>(
      `UPDATE catalog.lot_photos
       SET lease_token = $3, lease_expires_at = $4
       WHERE id = $1 AND state = 'processing' AND deleted_at IS NULL
         AND lease_expires_at <= $2
       RETURNING *`,
      [photoId, now, leaseToken, leaseExpiresAt],
    );
    return reclaimed.rows[0] ? toPhoto(reclaimed.rows[0]) : null;
  }

  async completeConfirmation(input: {
    readonly photoId: string;
    readonly expectedState: 'processing';
    readonly processedKey: string;
    readonly sizeBytes: number;
    readonly position: number;
    readonly leaseToken: string;
  }): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE catalog.lot_photos
       SET media_ref = $3, state = 'ready', content_type = 'image/webp', size_bytes = $4,
           position = $5, lease_token = NULL, lease_expires_at = NULL
       WHERE id = $1 AND state = $2 AND lease_token = $6 AND deleted_at IS NULL`,
      [
        input.photoId,
        input.expectedState,
        input.processedKey,
        input.sizeBytes,
        input.position,
        input.leaseToken,
      ],
    );
    return result.rowCount === 1;
  }

  async releaseLease(photoId: string, leaseToken: string): Promise<void> {
    await this.pool.query(
      `UPDATE catalog.lot_photos SET state = 'pending', lease_token = NULL, lease_expires_at = NULL
       WHERE id = $1 AND state = 'processing' AND lease_token = $2 AND deleted_at IS NULL`,
      [photoId, leaseToken],
    );
  }

  async listReadyForLots(
    lotIds: readonly string[],
  ): Promise<ReadonlyMap<string, readonly LotPhotoProps[]>> {
    if (lotIds.length === 0) return new Map();
    const result = await this.pool.query<PhotoRow>(
      `SELECT * FROM catalog.lot_photos WHERE lot_id = ANY($1::uuid[])
       AND state = 'ready' AND deleted_at IS NULL ORDER BY lot_id, position, id`,
      [lotIds],
    );
    const byLot = new Map<string, LotPhotoProps[]>();
    for (const row of result.rows) {
      const values = byLot.get(row.lot_id) ?? [];
      values.push(toPhoto(row));
      byLot.set(row.lot_id, values);
    }
    return byLot;
  }

  async deletePhoto(
    lotId: string,
    photoId: string,
    ownerId: string,
    now: Date,
  ): Promise<LotPhotoProps | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const lot = await client.query<{ status: string }>(
        `SELECT status FROM catalog.lots WHERE id = $1 AND provider_id = $2
         AND deleted_at IS NULL FOR UPDATE`,
        [lotId, ownerId],
      );
      if (!['draft', 'published'].includes(lot.rows[0]?.status ?? '')) {
        await client.query('ROLLBACK');
        return null;
      }
      const deleted = await client.query<PhotoRow>(
        `UPDATE catalog.lot_photos SET deleted_at = $3
         WHERE lot_id = $1 AND id = $2 AND deleted_at IS NULL RETURNING *`,
        [lotId, photoId, now],
      );
      if (!deleted.rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }
      await client.query(
        `WITH ordered AS (
          SELECT id, row_number() OVER (ORDER BY position, id)::integer AS next_position
          FROM catalog.lot_photos WHERE lot_id = $1 AND deleted_at IS NULL AND state = 'ready'
        )
        UPDATE catalog.lot_photos photos SET position = ordered.next_position
        FROM ordered WHERE photos.id = ordered.id`,
        [lotId],
      );
      await client.query('COMMIT');
      return toPhoto(deleted.rows[0]);
    } catch (error) {
      await safeRollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async reorder(input: {
    readonly lotId: string;
    readonly ownerId: string;
    readonly photoIds: readonly string[];
  }): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const lot = await client.query<{ status: string }>(
        `SELECT status FROM catalog.lots WHERE id = $1 AND provider_id = $2
         AND deleted_at IS NULL FOR UPDATE`,
        [input.lotId, input.ownerId],
      );
      if (!['draft', 'published'].includes(lot.rows[0]?.status ?? '')) {
        await client.query('ROLLBACK');
        return false;
      }
      const ready = await client.query<{ id: string }>(
        `SELECT id FROM catalog.lot_photos WHERE lot_id = $1 AND state = 'ready' AND deleted_at IS NULL`,
        [input.lotId],
      );
      if (
        ready.rows.length !== input.photoIds.length ||
        new Set(input.photoIds).size !== input.photoIds.length ||
        ready.rows.some(({ id }) => !input.photoIds.includes(id))
      ) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query(
        `UPDATE catalog.lot_photos photos SET position = ordered.ordinality::integer
         FROM unnest($2::uuid[]) WITH ORDINALITY AS ordered(id, ordinality)
         WHERE photos.id = ordered.id AND photos.lot_id = $1 AND photos.state = 'ready'
           AND photos.deleted_at IS NULL`,
        [input.lotId, input.photoIds],
      );
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await safeRollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async listKnownObjectKeys(): Promise<ReadonlySet<string>> {
    const result = await this.pool.query<{ media_ref: string }>(
      `SELECT media_ref FROM catalog.lot_photos WHERE deleted_at IS NULL`,
    );
    return new Set(result.rows.map(({ media_ref }) => media_ref));
  }

  async expirePending(now: Date): Promise<readonly LotPhotoProps[]> {
    const result = await this.pool.query<PhotoRow>(
      `UPDATE catalog.lot_photos SET deleted_at = $1, lease_token = NULL, lease_expires_at = NULL
       WHERE state = 'pending' AND deleted_at IS NULL AND expires_at <= $1 RETURNING *`,
      [now],
    );
    return result.rows.map(toPhoto);
  }

  async softDelete(photoId: string, now: Date): Promise<void> {
    await this.pool.query(
      `UPDATE catalog.lot_photos SET deleted_at = $2, lease_token = NULL, lease_expires_at = NULL
       WHERE id = $1 AND deleted_at IS NULL`,
      [photoId, now],
    );
  }
}

async function safeRollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // A failed transaction may already have been rolled back by PostgreSQL.
  }
}
