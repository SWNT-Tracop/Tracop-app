import { randomBytes, randomUUID } from 'node:crypto';
import { DomainError } from '../../../shared/kernel/domain-error.js';
import {
  type LotPhotoRepository,
  type PhotoProcessorPort,
  type PhotoUploadRateLimitPort,
} from '../ports/lot-photo-ports.js';
import type { StoragePort } from '../ports/storage-port.js';

type Actor = { readonly sub: string; readonly role: string };
type ReservationResult = {
  readonly state: 'pending' | 'processing' | 'ready';
  readonly uploadPolicy?: {
    readonly url: string;
    readonly fields: Readonly<Record<string, string>>;
    readonly expiresAt: string;
  };
};

export type LotPhotoSettings = {
  readonly maxCount: number;
  readonly maxBytes: number;
  readonly maxInputPixels: number;
  readonly maxInputDimension: number;
  readonly maxOutputDimension: number;
  readonly pendingTtlSeconds: number;
  readonly uploadUrlTtlSeconds: number;
  readonly downloadUrlTtlSeconds: number;
  readonly purgeGraceSeconds: number;
  readonly webpQuality: number;
  readonly conversionConcurrency: number;
  readonly processingLeaseSeconds: number;
};

export class LotPhotoService {
  private runningConversions = 0;
  private readonly waitingConversions: Array<() => void> = [];

  constructor(
    private readonly photos: LotPhotoRepository,
    private readonly storage: StoragePort,
    private readonly processor: PhotoProcessorPort,
    private readonly rateLimit: PhotoUploadRateLimitPort,
    private readonly settings: LotPhotoSettings,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async prepareUpload(actor: Actor, lotId: string, photoId: string): Promise<ReservationResult> {
    this.requireProvider(actor);
    if (!isUuidV7(photoId))
      throw new DomainError('El id de foto debe ser UUID v7.', 'invalid_photo_id');
    const now = this.now();
    this.rateLimit.consume(actor.sub, now);
    const uploadExpiresAt = new Date(now.getTime() + this.settings.uploadUrlTtlSeconds * 1000);
    const reservation = await this.photos.reserveUpload({
      lotId,
      photoId,
      ownerId: actor.sub,
      incomingKey: `incoming/${randomBytes(32).toString('base64url')}`,
      now,
      expiresAt: new Date(now.getTime() + this.settings.pendingTtlSeconds * 1000),
      maxCount: this.settings.maxCount,
    });
    if (reservation.kind === 'not_found') throw new DomainError('Lote no encontrado.', 'not_found');
    if (reservation.kind === 'forbidden')
      throw new DomainError('No tienes permiso para este recurso.', 'forbidden');
    if (reservation.kind === 'conflict')
      throw new DomainError('Conflicto de versión.', 'version_conflict');
    if (reservation.kind === 'invalid_state')
      throw new DomainError('El lote no admite fotos en este estado.', 'invalid_transition');
    if (reservation.kind === 'limit')
      throw new DomainError('El lote alcanzó el máximo de fotos.', 'photo_limit');
    if (reservation.kind === 'ready') return { state: 'ready' };
    if (reservation.kind === 'processing') return { state: 'processing' };
    if (reservation.kind !== 'created' && reservation.kind !== 'pending') {
      throw new DomainError('Conflicto de versión.', 'version_conflict');
    }

    const policyExpiresAt = new Date(
      Math.min(uploadExpiresAt.getTime(), reservation.photo.expiresAt.getTime()),
    );
    try {
      const policy = await this.storage.createUploadPolicy({
        key: reservation.photo.mediaRef,
        maxBytes: this.settings.maxBytes,
        expiresAt: policyExpiresAt,
      });
      return {
        state: 'pending',
        uploadPolicy: { ...policy, expiresAt: policy.expiresAt.toISOString() },
      };
    } catch {
      if (reservation.kind === 'created') {
        await this.photos.softDelete(reservation.photo.id, this.now());
      }
      throw new DomainError('No se pudo preparar la carga.', 'storage_unavailable');
    }
  }

  async confirm(actor: Actor, lotId: string, photoId: string): Promise<ReservationResult> {
    this.requireProvider(actor);
    const current = await this.photos.findForOwner(lotId, photoId, actor.sub);
    if (!current) throw new DomainError('Foto no encontrada.', 'not_found');
    if (current.state === 'ready') return { state: 'ready' };
    if (
      current.state === 'processing' &&
      current.leaseExpiresAt &&
      current.leaseExpiresAt > this.now()
    ) {
      return { state: 'processing' };
    }
    if (current.state === 'pending' && current.expiresAt <= this.now()) {
      await this.photos.softDelete(photoId, this.now());
      await this.bestEffortDelete(current.mediaRef);
      throw new DomainError('La carga de la foto venció.', 'photo_expired');
    }

    const now = this.now();
    const leaseToken = randomUUID();
    const lease = await this.photos.claimConfirmation(
      photoId,
      now,
      leaseToken,
      new Date(now.getTime() + this.settings.processingLeaseSeconds * 1000),
    );
    if (!lease) {
      const afterClaim = await this.photos.findForOwner(lotId, photoId, actor.sub);
      if (afterClaim?.state === 'ready') return { state: 'ready' };
      if (afterClaim?.state === 'processing') return { state: 'processing' };
      throw new DomainError('No se puede confirmar esta foto.', 'photo_not_pending');
    }

    let processedKey: string | undefined;
    try {
      const metadata = await this.storage.headObject(lease.mediaRef);
      if (!metadata)
        throw new DomainError('No se encontró la imagen cargada.', 'photo_upload_missing');
      if (metadata.sizeBytes < 1 || metadata.sizeBytes > this.settings.maxBytes) {
        throw new DomainError('La imagen supera el tamaño permitido.', 'photo_size_invalid');
      }
      const inputBytes = await this.storage.getObject(lease.mediaRef);
      if (
        inputBytes.byteLength !== metadata.sizeBytes ||
        inputBytes.byteLength > this.settings.maxBytes
      ) {
        throw new DomainError('La imagen supera el tamaño permitido.', 'photo_size_invalid');
      }
      if (!detectImageFormat(inputBytes)) {
        throw new DomainError(
          'El archivo no es una imagen JPEG, PNG o WebP válida.',
          'photo_format_invalid',
        );
      }
      let image: { readonly bytes: Uint8Array; readonly width: number; readonly height: number };
      try {
        image = await this.withConversionSlot(() =>
          this.processor.process({
            bytes: inputBytes,
            maxInputPixels: this.settings.maxInputPixels,
            maxInputDimension: this.settings.maxInputDimension,
            maxOutputDimension: this.settings.maxOutputDimension,
            quality: this.settings.webpQuality,
          }),
        );
      } catch (error) {
        if (error instanceof DomainError) throw error;
        throw new DomainError('La imagen no se puede decodificar.', mapImageError(error));
      }
      if (image.bytes.byteLength > this.settings.maxBytes) {
        throw new DomainError(
          'La imagen procesada supera el tamaño permitido.',
          'photo_size_invalid',
        );
      }
      processedKey = `photos/${randomBytes(32).toString('base64url')}.webp`;
      await this.storage.putObject({
        key: processedKey,
        body: image.bytes,
        contentType: 'image/webp',
      });
      const completed = await this.photos.completeConfirmation({
        photoId,
        expectedState: 'processing',
        processedKey,
        sizeBytes: image.bytes.byteLength,
        position: lease.position,
        leaseToken,
      });
      if (!completed) {
        await this.bestEffortDelete(processedKey);
        const afterLease = await this.photos.findForOwner(lotId, photoId, actor.sub);
        if (afterLease?.state === 'ready') return { state: 'ready' };
        return { state: 'processing' };
      }
      await this.bestEffortDelete(lease.mediaRef);
      return { state: 'ready' };
    } catch (error) {
      if (isValidationFailure(error)) {
        await this.photos.softDelete(photoId, this.now());
        await this.bestEffortDelete(lease.mediaRef);
        if (processedKey) await this.bestEffortDelete(processedKey);
        if (error instanceof DomainError) throw error;
        throw new DomainError('La imagen no cumple los requisitos.', mapImageError(error));
      }
      if (processedKey) await this.bestEffortDelete(processedKey);
      await this.photos.releaseLease(photoId, leaseToken);
      if (error instanceof DomainError) throw error;
      throw new DomainError('No se pudo procesar la imagen.', 'storage_unavailable');
    }
  }

  async delete(actor: Actor, lotId: string, photoId: string): Promise<void> {
    this.requireProvider(actor);
    const photo = await this.photos.deletePhoto(lotId, photoId, actor.sub, this.now());
    if (!photo) throw new DomainError('Foto no encontrada.', 'not_found');
    await this.bestEffortDelete(photo.mediaRef);
  }

  async reorder(actor: Actor, lotId: string, photoIds: readonly string[]): Promise<void> {
    this.requireProvider(actor);
    const changed = await this.photos.reorder({ lotId, ownerId: actor.sub, photoIds });
    if (!changed) throw new DomainError('El orden de fotos no es válido.', 'photo_order_invalid');
  }

  async photosForLots(
    lotIds: readonly string[],
    detailLotIds: ReadonlySet<string> = new Set(),
  ): Promise<
    ReadonlyMap<
      string,
      readonly { readonly id: string; readonly position: number; readonly url: string }[]
    >
  > {
    const ready = await this.photos.listReadyForLots(lotIds);
    const response = new Map<string, { id: string; position: number; url: string }[]>();
    for (const [lotId, photos] of ready) {
      const selected = detailLotIds.has(lotId) ? photos : photos.slice(0, 1);
      const values = await Promise.all(
        selected.map(async (photo) => ({
          id: photo.id,
          position: photo.position,
          url: await this.storage.createDownloadUrl(
            photo.mediaRef,
            new Date(this.now().getTime() + this.settings.downloadUrlTtlSeconds * 1000),
          ),
        })),
      );
      response.set(lotId, values);
    }
    return response;
  }

  async purgeOrphans(): Promise<number> {
    const now = this.now();
    await this.photos.expirePending(now);
    const known = await this.photos.listKnownObjectKeys();
    const olderThan = now.getTime() - this.settings.purgeGraceSeconds * 1000;
    let removed = 0;
    for (const prefix of ['incoming/', 'photos/']) {
      for await (const object of this.storage.listObjects(prefix)) {
        if (object.lastModified.getTime() < olderThan && !known.has(object.key)) {
          await this.storage.deleteObject(object.key);
          removed += 1;
        }
      }
    }
    return removed;
  }

  private requireProvider(actor: Actor): void {
    if (actor.role !== 'producer' && actor.role !== 'supplier') {
      throw new DomainError('No tienes permiso para este recurso.', 'forbidden');
    }
  }

  private async withConversionSlot<T>(operation: () => Promise<T>): Promise<T> {
    if (this.runningConversions >= this.settings.conversionConcurrency) {
      await new Promise<void>((resolve) => this.waitingConversions.push(resolve));
    } else {
      this.runningConversions += 1;
    }
    try {
      return await operation();
    } finally {
      const next = this.waitingConversions.shift();
      if (next) next();
      else this.runningConversions -= 1;
    }
  }

  private async bestEffortDelete(key: string): Promise<void> {
    try {
      await this.storage.deleteObject(key);
    } catch {
      // Unreferenced objects are removed later by the grace-period orphan purge.
    }
  }
}

export function detectImageFormat(
  bytes: Uint8Array,
): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'image/jpeg';
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  )
    return 'image/png';
  if (
    bytes.length >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF' &&
    Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP'
  )
    return 'image/webp';
  return null;
}

function isUuidV7(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isValidationFailure(error: unknown): boolean {
  if (error instanceof DomainError) {
    return [
      'photo_size_invalid',
      'photo_format_invalid',
      'photo_dimensions_invalid',
      'photo_image_invalid',
    ].includes(error.code);
  }
  return (
    error instanceof Error &&
    ['unsupported_image_format', 'invalid_image_dimensions', 'image_dimensions_exceeded'].some(
      (prefix) => error.message.startsWith(prefix),
    )
  );
}

function mapImageError(error: unknown): string {
  if (error instanceof Error && error.message.startsWith('image_dimensions_exceeded'))
    return 'photo_dimensions_invalid';
  if (error instanceof Error && error.message.startsWith('unsupported_image_format'))
    return 'photo_format_invalid';
  return 'photo_image_invalid';
}
