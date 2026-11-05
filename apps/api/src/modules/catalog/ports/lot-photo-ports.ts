import type { LotPhotoProps } from '../domain/lot-photo.js';
import type { StoragePort } from './storage-port.js';

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
  reorder(input: {
    readonly lotId: string;
    readonly ownerId: string;
    readonly photoIds: readonly string[];
  }): Promise<boolean>;
  listKnownObjectKeys(): Promise<ReadonlySet<string>>;
  expirePending(now: Date): Promise<readonly LotPhotoProps[]>;
  softDelete(photoId: string, now: Date): Promise<void>;
}

export interface PhotoProcessorPort {
  process(input: {
    readonly bytes: Uint8Array;
    readonly maxInputPixels: number;
    readonly maxInputDimension: number;
    readonly maxOutputDimension: number;
    readonly quality: number;
  }): Promise<{ readonly bytes: Uint8Array; readonly width: number; readonly height: number }>;
}

export interface PhotoUploadRateLimitPort {
  consume(userId: string, now: Date): void;
}

export const LOT_PHOTO_REPOSITORY = Symbol('LOT_PHOTO_REPOSITORY');
export const PHOTO_PROCESSOR_PORT = Symbol('PHOTO_PROCESSOR_PORT');
export const PHOTO_UPLOAD_RATE_LIMIT_PORT = Symbol('PHOTO_UPLOAD_RATE_LIMIT_PORT');

export type LotPhotoInfrastructure = {
  readonly storage: StoragePort;
  readonly photos: LotPhotoRepository;
  readonly processor: PhotoProcessorPort;
};
