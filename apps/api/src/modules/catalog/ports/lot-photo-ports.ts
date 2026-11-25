import type { LotPhotoProps } from '../domain/lot-photo.js';
import type { PhotoProcessorPort } from '../../../shared/ports/photo-processor.js';
import type { StoragePort } from '../../../shared/ports/storage.js';

export type LotPhotoReservation =
  | { readonly kind: 'created'; readonly photo: LotPhotoProps }
  | { readonly kind: 'pending'; readonly photo: LotPhotoProps }
  | { readonly kind: 'processing'; readonly photo: LotPhotoProps }
  | { readonly kind: 'ready'; readonly photo: LotPhotoProps }
  | { readonly kind: 'not_found' | 'forbidden' | 'invalid_state' | 'limit' | 'conflict' };

export interface LotPhotoRepository {
  reserveUpload(input: {
    readonly lotId: string;
    readonly photoId: string;
    readonly ownerId: string;
    readonly incomingKey: string;
    readonly now: Date;
    readonly expiresAt: Date;
    readonly maxCount: number;
  }): Promise<LotPhotoReservation>;
  findForOwner(lotId: string, photoId: string, ownerId: string): Promise<LotPhotoProps | null>;
  claimConfirmation(
    photoId: string,
    now: Date,
    leaseToken: string,
    leaseExpiresAt: Date,
  ): Promise<LotPhotoProps | null>;
  completeConfirmation(input: {
    readonly photoId: string;
    readonly expectedState: 'processing';
    readonly processedKey: string;
    readonly sizeBytes: number;
    readonly position: number;
    readonly leaseToken: string;
  }): Promise<boolean>;
  releaseLease(photoId: string, leaseToken: string): Promise<void>;
  listReadyForLots(
    lotIds: readonly string[],
  ): Promise<ReadonlyMap<string, readonly LotPhotoProps[]>>;
  deletePhoto(
    lotId: string,
    photoId: string,
    ownerId: string,
    now: Date,
  ): Promise<LotPhotoProps | null>;
  /** `not_found` when the lot does not exist or belongs to someone else (a third party gets 404). */
  reorder(input: {
    readonly lotId: string;
    readonly ownerId: string;
    readonly photoIds: readonly string[];
  }): Promise<'reordered' | 'not_found' | 'invalid'>;
  listKnownObjectKeys(): Promise<ReadonlySet<string>>;
  expirePending(now: Date): Promise<readonly LotPhotoProps[]>;
  softDelete(photoId: string, now: Date): Promise<void>;
  softDeleteForLot(lotId: string, now: Date): Promise<void>;
}

export interface PhotoUploadRateLimitPort {
  consume(userId: string, now: Date): void;
}

export const LOT_PHOTO_REPOSITORY = Symbol('LOT_PHOTO_REPOSITORY');
export const PHOTO_UPLOAD_RATE_LIMIT_PORT = Symbol('PHOTO_UPLOAD_RATE_LIMIT_PORT');

export type LotPhotoInfrastructure = {
  readonly storage: StoragePort;
  readonly photos: LotPhotoRepository;
  readonly processor: PhotoProcessorPort;
};
