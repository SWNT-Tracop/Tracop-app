import type { LotPhotoProps } from '../domain/lot-photo.js';
import {
  type LotPhotoRepository,
  type PhotoProcessorPort,
  type PhotoUploadRateLimitPort,
} from '../ports/lot-photo-ports.js';
import type { StoragePort } from '../ports/storage-port.js';
import { LotPhotoService, type LotPhotoSettings } from './lot-photo-service.js';

const now = new Date('2026-11-02T12:00:00.000Z');
const settings: LotPhotoSettings = {
  maxCount: 5,
  maxBytes: 5 * 1024 * 1024,
  maxInputPixels: 25_000_000,
  maxInputDimension: 10_000,
  maxOutputDimension: 2_048,
  pendingTtlSeconds: 1_800,
  uploadUrlTtlSeconds: 900,
  downloadUrlTtlSeconds: 300,
  purgeGraceSeconds: 3_600,
  webpQuality: 80,
  conversionConcurrency: 2,
  processingLeaseSeconds: 300,
};

const photo = (overrides: Partial<LotPhotoProps> = {}): LotPhotoProps => ({
  id: '0190f47a-8b45-7cc2-9a1e-123456789abc',
  lotId: '0190f47a-8b45-7cc2-9a1e-123456789abd',
  mediaRef: 'incoming/random-key',
  state: 'pending',
  contentType: null,
  sizeBytes: null,
  position: 1,
  createdAt: now,
  expiresAt: new Date(now.getTime() + 1_800_000),
  leaseToken: null,
  leaseExpiresAt: null,
  deletedAt: null,
  ...overrides,
});

const makeRepository = () => ({
  reserveUpload: jest.fn(),
  findForOwner: jest.fn(),
  claimConfirmation: jest.fn(),
  completeConfirmation: jest.fn(),
  releaseLease: jest.fn().mockResolvedValue(undefined),
  listReadyForLots: jest.fn().mockResolvedValue(new Map()),
  deletePhoto: jest.fn(),
  reorder: jest.fn(),
  listKnownObjectKeys: jest.fn().mockResolvedValue(new Set<string>()),
  expirePending: jest.fn().mockResolvedValue([]),
  softDelete: jest.fn().mockResolvedValue(undefined),
});

const makeStorage = () => ({
  createUploadPolicy: jest.fn().mockResolvedValue({
    url: 'https://storage.example/upload',
    fields: { key: 'incoming/random-key' },
    expiresAt: new Date(now.getTime() + 900_000),
  }),
  headObject: jest.fn(),
  getObject: jest.fn(),
  putObject: jest.fn().mockResolvedValue(undefined),
  createDownloadUrl: jest.fn((key: string, expiresAt: Date) =>
    Promise.resolve(`${key}?expires=${expiresAt.toISOString()}`),
  ),
  deleteObject: jest.fn().mockResolvedValue(undefined),
  listObjects: jest.fn(async function* (
    prefix: string,
  ): AsyncGenerator<{ key: string; sizeBytes: number; lastModified: Date }> {
    void prefix;
    yield* [] as Array<{ key: string; sizeBytes: number; lastModified: Date }>;
  }),
});

const makeProcessor = () => ({
  process: jest.fn().mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), width: 10, height: 10 }),
});

const makeRateLimit = () => ({ consume: jest.fn() });

const makeService = (dependencies?: {
  repository?: ReturnType<typeof makeRepository>;
  storage?: ReturnType<typeof makeStorage>;
  processor?: ReturnType<typeof makeProcessor>;
  rateLimit?: ReturnType<typeof makeRateLimit>;
}) => {
  const repository = dependencies?.repository ?? makeRepository();
  const storage = dependencies?.storage ?? makeStorage();
  const processor = dependencies?.processor ?? makeProcessor();
  const rateLimit = dependencies?.rateLimit ?? makeRateLimit();
  const service = new LotPhotoService(
    repository as unknown as LotPhotoRepository,
    storage as unknown as StoragePort,
    processor as unknown as PhotoProcessorPort,
    rateLimit as unknown as PhotoUploadRateLimitPort,
    settings,
    () => now,
  );
  return { service, repository, storage, processor, rateLimit };
};

const actor = { sub: '0190f47a-8b45-7cc2-9a1e-123456789abe', role: 'producer' };

describe('LotPhotoService', () => {
  describe('prepareUpload', () => {
    it('rejects non-provider roles and invalid UUID v7 identifiers', async () => {
      const { service } = makeService();
      await expect(
        service.prepareUpload({ ...actor, role: 'buyer' }, 'lot', photo().id),
      ).rejects.toMatchObject({
        code: 'forbidden',
      });
      await expect(
        service.prepareUpload(actor, 'lot', '018f47a2-8b45-4cc2-9a1e-123456789abc'),
      ).rejects.toMatchObject({
        code: 'invalid_photo_id',
      });
    });

    it('applies the upload rate limit before reserving quota', async () => {
      const rateLimit = makeRateLimit();
      rateLimit.consume.mockImplementation(() => {
        throw Object.assign(new Error('limited'), { code: 'rate_limited' });
      });
      const { service, repository } = makeService({ rateLimit });
      await expect(service.prepareUpload(actor, 'lot', photo().id)).rejects.toThrow('limited');
      expect(repository.reserveUpload).not.toHaveBeenCalled();
    });

    it.each([
      ['not_found', 'not_found'],
      ['conflict', 'version_conflict'],
      ['invalid_state', 'invalid_transition'],
      ['limit', 'photo_limit'],
    ])('maps reservoir %s to %s', async (kind, code) => {
      const repository = makeRepository();
      repository.reserveUpload.mockResolvedValue({ kind });
      const { service } = makeService({ repository });
      await expect(service.prepareUpload(actor, photo().lotId, photo().id)).rejects.toMatchObject({
        code,
      });
    });

    it('returns ready and processing states without a policy', async () => {
      const repository = makeRepository();
      repository.reserveUpload.mockResolvedValueOnce({
        kind: 'ready',
        photo: photo({ state: 'ready' }),
      });
      repository.reserveUpload.mockResolvedValueOnce({
        kind: 'processing',
        photo: photo({ state: 'processing' }),
      });
      const { service, storage } = makeService({ repository });
      await expect(service.prepareUpload(actor, photo().lotId, photo().id)).resolves.toEqual({
        state: 'ready',
      });
      await expect(service.prepareUpload(actor, photo().lotId, photo().id)).resolves.toEqual({
        state: 'processing',
      });
      expect(storage.createUploadPolicy).not.toHaveBeenCalled();
    });

    it('signs a bounded policy with the reserved key for new and pending rows', async () => {
      const repository = makeRepository();
      repository.reserveUpload.mockResolvedValueOnce({
        kind: 'created',
        photo: photo({ mediaRef: 'incoming/new' }),
      });
      repository.reserveUpload.mockResolvedValueOnce({
        kind: 'pending',
        photo: photo({ mediaRef: 'incoming/existing' }),
      });
      const { service, storage } = makeService({ repository });

      await expect(service.prepareUpload(actor, photo().lotId, photo().id)).resolves.toMatchObject({
        state: 'pending',
        uploadPolicy: { url: 'https://storage.example/upload' },
      });
      await expect(service.prepareUpload(actor, photo().lotId, photo().id)).resolves.toMatchObject({
        state: 'pending',
      });
      expect(storage.createUploadPolicy).toHaveBeenNthCalledWith(1, {
        key: 'incoming/new',
        maxBytes: settings.maxBytes,
        expiresAt: new Date(now.getTime() + 900_000),
      });
      expect(storage.createUploadPolicy).toHaveBeenNthCalledWith(2, {
        key: 'incoming/existing',
        maxBytes: settings.maxBytes,
        expiresAt: new Date(now.getTime() + 900_000),
      });
    });

    it('releases a newly reserved row when the storage policy fails', async () => {
      const repository = makeRepository();
      repository.reserveUpload.mockResolvedValue({ kind: 'created', photo: photo() });
      const storage = makeStorage();
      storage.createUploadPolicy.mockRejectedValue(new Error('storage down'));
      const { service } = makeService({ repository, storage });

      await expect(service.prepareUpload(actor, photo().lotId, photo().id)).rejects.toMatchObject({
        code: 'storage_unavailable',
      });
      expect(repository.softDelete).toHaveBeenCalledWith(photo().id, now);
    });
  });

  describe('confirm', () => {
    it('returns ready immediately and exposes an active processing lease', async () => {
      const repository = makeRepository();
      repository.findForOwner.mockResolvedValueOnce(photo({ state: 'ready' }));
      repository.findForOwner.mockResolvedValueOnce(
        photo({ state: 'processing', leaseExpiresAt: new Date(now.getTime() + 60_000) }),
      );
      const { service, storage } = makeService({ repository });

      await expect(service.confirm(actor, photo().lotId, photo().id)).resolves.toEqual({
        state: 'ready',
      });
      await expect(service.confirm(actor, photo().lotId, photo().id)).resolves.toEqual({
        state: 'processing',
      });
      expect(storage.headObject).not.toHaveBeenCalled();
    });

    it('expires a stale pending row and deletes its original object', async () => {
      const repository = makeRepository();
      repository.findForOwner.mockResolvedValue(photo({ expiresAt: new Date(now.getTime() - 1) }));
      const { service, storage } = makeService({ repository });

      await expect(service.confirm(actor, photo().lotId, photo().id)).rejects.toMatchObject({
        code: 'photo_expired',
      });
      expect(repository.softDelete).toHaveBeenCalledWith(photo().id, now);
      expect(storage.deleteObject).toHaveBeenCalledWith(photo().mediaRef);
    });

    it('returns a deterministic state when another confirmation already claimed the row', async () => {
      const repository = makeRepository();
      repository.findForOwner
        .mockResolvedValueOnce(photo())
        .mockResolvedValueOnce(photo({ state: 'ready' }));
      repository.claimConfirmation.mockResolvedValue(null);
      const { service } = makeService({ repository });
      await expect(service.confirm(actor, photo().lotId, photo().id)).resolves.toEqual({
        state: 'ready',
      });

      repository.findForOwner
        .mockResolvedValueOnce(photo())
        .mockResolvedValueOnce(photo({ state: 'processing' }));
      await expect(service.confirm(actor, photo().lotId, photo().id)).resolves.toEqual({
        state: 'processing',
      });

      repository.findForOwner.mockResolvedValueOnce(photo()).mockResolvedValueOnce(null);
      await expect(service.confirm(actor, photo().lotId, photo().id)).rejects.toMatchObject({
        code: 'photo_not_pending',
      });
    });

    it('releases the lease when the uploaded object is missing or storage fails', async () => {
      const repository = makeRepository();
      repository.findForOwner.mockResolvedValue(photo());
      repository.claimConfirmation.mockResolvedValue(
        photo({ state: 'processing', leaseToken: 'lease' }),
      );
      const storage = makeStorage();
      storage.headObject.mockResolvedValueOnce(null);
      const { service } = makeService({ repository, storage });

      await expect(service.confirm(actor, photo().lotId, photo().id)).rejects.toMatchObject({
        code: 'photo_upload_missing',
      });
      expect(repository.releaseLease).toHaveBeenCalledWith(photo().id, expect.any(String));

      storage.headObject.mockResolvedValueOnce({
        key: photo().mediaRef,
        sizeBytes: 4,
        lastModified: now,
      });
      storage.getObject.mockRejectedValueOnce(new Error('read failed'));
      await expect(service.confirm(actor, photo().lotId, photo().id)).rejects.toMatchObject({
        code: 'storage_unavailable',
      });
    });

    it.each([
      ['photo_size_invalid', { sizeBytes: settings.maxBytes + 1 }, async () => undefined],
      ['photo_format_invalid', { sizeBytes: 3 }, async () => Buffer.from([1, 2, 3])],
    ])(
      'deletes the original and reports %s on validation failure',
      async (code, metadata, read) => {
        const repository = makeRepository();
        repository.findForOwner.mockResolvedValue(photo());
        repository.claimConfirmation.mockResolvedValue(
          photo({ state: 'processing', leaseToken: 'lease' }),
        );
        const storage = makeStorage();
        storage.headObject.mockResolvedValue({
          key: photo().mediaRef,
          lastModified: now,
          ...metadata,
        });
        storage.getObject.mockImplementation(read);
        const { service } = makeService({ repository, storage });

        await expect(service.confirm(actor, photo().lotId, photo().id)).rejects.toMatchObject({
          code,
        });
        expect(repository.softDelete).toHaveBeenCalledWith(photo().id, now);
        expect(storage.deleteObject).toHaveBeenCalledWith(photo().mediaRef);
      },
    );

    it('reports processor decode failures as typed image errors and frees quota', async () => {
      const repository = makeRepository();
      repository.findForOwner.mockResolvedValue(photo());
      repository.claimConfirmation.mockResolvedValue(
        photo({ state: 'processing', leaseToken: 'lease' }),
      );
      const storage = makeStorage();
      storage.headObject.mockResolvedValue({
        key: photo().mediaRef,
        sizeBytes: 3,
        lastModified: now,
      });
      storage.getObject.mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff]));
      const processor = makeProcessor();
      processor.process.mockRejectedValue(new Error('image_dimensions_exceeded'));
      const { service } = makeService({ repository, storage, processor });

      await expect(service.confirm(actor, photo().lotId, photo().id)).rejects.toMatchObject({
        code: 'photo_dimensions_invalid',
      });
      expect(repository.softDelete).toHaveBeenCalled();
    });

    it('stores the processed WebP, completes atomically and deletes the original', async () => {
      const repository = makeRepository();
      repository.findForOwner.mockResolvedValue(photo());
      repository.claimConfirmation.mockResolvedValue(
        photo({ state: 'processing', leaseToken: 'lease', position: 2 }),
      );
      repository.completeConfirmation.mockResolvedValue(true);
      const storage = makeStorage();
      storage.headObject.mockResolvedValue({
        key: photo().mediaRef,
        sizeBytes: 3,
        lastModified: now,
      });
      storage.getObject.mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff]));
      const { service } = makeService({ repository, storage });

      await expect(service.confirm(actor, photo().lotId, photo().id)).resolves.toEqual({
        state: 'ready',
      });
      expect(storage.putObject).toHaveBeenCalledWith({
        key: expect.stringMatching(/^photos\/.+\.webp$/),
        body: new Uint8Array([1, 2, 3]),
        contentType: 'image/webp',
      });
      expect(repository.completeConfirmation).toHaveBeenCalledWith(
        expect.objectContaining({
          photoId: photo().id,
          expectedState: 'processing',
          sizeBytes: 3,
          position: 2,
          leaseToken: expect.any(String),
        }),
      );
      expect(storage.deleteObject).toHaveBeenCalledWith(photo().mediaRef);
    });

    it('discards the processed object when another worker completed first', async () => {
      const repository = makeRepository();
      repository.findForOwner.mockResolvedValue(photo());
      repository.claimConfirmation.mockResolvedValue(
        photo({ state: 'processing', leaseToken: 'lease' }),
      );
      repository.completeConfirmation.mockResolvedValue(false);
      repository.findForOwner
        .mockResolvedValueOnce(photo())
        .mockResolvedValueOnce(photo({ state: 'ready' }));
      const storage = makeStorage();
      storage.headObject.mockResolvedValue({
        key: photo().mediaRef,
        sizeBytes: 3,
        lastModified: now,
      });
      storage.getObject.mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff]));
      const { service } = makeService({ repository, storage });

      await expect(service.confirm(actor, photo().lotId, photo().id)).resolves.toEqual({
        state: 'ready',
      });
      expect(storage.deleteObject).toHaveBeenCalledWith(expect.stringMatching(/^photos\//));
    });

    it('releases the lease on infrastructure failures without freeing quota', async () => {
      const repository = makeRepository();
      repository.findForOwner.mockResolvedValue(photo());
      repository.claimConfirmation.mockResolvedValue(
        photo({ state: 'processing', leaseToken: 'lease' }),
      );
      const storage = makeStorage();
      storage.headObject.mockResolvedValue({
        key: photo().mediaRef,
        sizeBytes: 3,
        lastModified: now,
      });
      storage.getObject.mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff]));
      storage.putObject.mockRejectedValue(new Error('write failed'));
      const { service } = makeService({ repository, storage });

      await expect(service.confirm(actor, photo().lotId, photo().id)).rejects.toMatchObject({
        code: 'storage_unavailable',
      });
      expect(repository.releaseLease).toHaveBeenCalledWith(photo().id, expect.any(String));
      expect(repository.softDelete).not.toHaveBeenCalled();
    });

    it('limits simultaneous conversions to the configured semaphore', async () => {
      let active = 0;
      let maximum = 0;
      const repository = makeRepository();
      repository.findForOwner.mockResolvedValue(photo());
      repository.claimConfirmation.mockResolvedValue(
        photo({ state: 'processing', leaseToken: 'lease' }),
      );
      repository.completeConfirmation.mockResolvedValue(true);
      const storage = makeStorage();
      storage.headObject.mockResolvedValue({
        key: photo().mediaRef,
        sizeBytes: 3,
        lastModified: now,
      });
      storage.getObject.mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff]));
      const processor = makeProcessor();
      processor.process.mockImplementation(async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return { bytes: new Uint8Array([1, 2, 3]), width: 10, height: 10 };
      });
      const { service } = makeService({ repository, storage, processor });

      await Promise.all([
        service.confirm(actor, photo().lotId, photo().id),
        service.confirm(actor, photo().lotId, photo().id),
        service.confirm(actor, photo().lotId, photo().id),
      ]);
      expect(maximum).toBeLessThanOrEqual(settings.conversionConcurrency);
    });
  });

  describe('delete, reorder and reads', () => {
    it('deletes the stored object and reports missing photos', async () => {
      const repository = makeRepository();
      repository.deletePhoto
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(photo({ state: 'ready' }));
      const { service, storage } = makeService({ repository });

      await expect(service.delete(actor, photo().lotId, photo().id)).rejects.toMatchObject({
        code: 'not_found',
      });
      await expect(service.delete(actor, photo().lotId, photo().id)).resolves.toBeUndefined();
      expect(storage.deleteObject).toHaveBeenCalledWith(photo().mediaRef);
    });

    it('rejects invalid reorder payloads and accepts complete ones', async () => {
      const repository = makeRepository();
      repository.reorder.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      const { service } = makeService({ repository });

      await expect(service.reorder(actor, photo().lotId, [photo().id])).rejects.toMatchObject({
        code: 'photo_order_invalid',
      });
      await expect(service.reorder(actor, photo().lotId, [photo().id])).resolves.toBeUndefined();
    });

    it('returns only the cover for listings, all photos for detail and never signs incoming keys', async () => {
      const repository = makeRepository();
      repository.listReadyForLots.mockResolvedValue(
        new Map([
          [
            photo().lotId,
            [
              photo({ id: 'photo-1', state: 'ready', mediaRef: 'photos/one.webp', position: 1 }),
              photo({ id: 'photo-2', state: 'ready', mediaRef: 'photos/two.webp', position: 2 }),
            ],
          ],
        ]),
      );
      const { service, storage } = makeService({ repository });

      const listing = await service.photosForLots([photo().lotId]);
      expect(listing.get(photo().lotId)).toHaveLength(1);
      expect(listing.get(photo().lotId)?.[0]?.url).toContain('photos/one.webp');
      expect(storage.createDownloadUrl).toHaveBeenCalledTimes(1);

      const detail = await service.photosForLots([photo().lotId], new Set([photo().lotId]));
      expect(detail.get(photo().lotId)).toHaveLength(2);
      expect(detail.get(photo().lotId)?.map(({ url }) => url)).toEqual([
        expect.stringContaining('photos/one.webp'),
        expect.stringContaining('photos/two.webp'),
      ]);
      expect(detail.get(photo().lotId)?.some(({ url }) => url.includes('incoming/'))).toBe(false);
    });
  });

  describe('purgeOrphans', () => {
    it('expires pending rows and removes only unknown objects older than the grace period', async () => {
      const repository = makeRepository();
      repository.listKnownObjectKeys.mockResolvedValue(new Set(['photos/known.webp']));
      const nowMs = now.getTime();
      const objects = [
        { key: 'incoming/old.webp', sizeBytes: 1, lastModified: new Date(nowMs - 3_600_001) },
        { key: 'photos/old.webp', sizeBytes: 1, lastModified: new Date(nowMs - 3_600_001) },
        { key: 'photos/known.webp', sizeBytes: 1, lastModified: new Date(nowMs - 3_600_001) },
        { key: 'photos/recent.webp', sizeBytes: 1, lastModified: new Date(nowMs - 1_000) },
      ];
      const storage = makeStorage();
      storage.listObjects.mockImplementation(async function* (prefix: string) {
        yield* objects.filter(({ key }) => key.startsWith(prefix));
      });
      const { service } = makeService({ repository, storage });

      await expect(service.purgeOrphans()).resolves.toBe(2);
      expect(repository.expirePending).toHaveBeenCalledWith(now);
      expect(storage.deleteObject).toHaveBeenCalledWith('incoming/old.webp');
      expect(storage.deleteObject).toHaveBeenCalledWith('photos/old.webp');
      expect(storage.deleteObject).not.toHaveBeenCalledWith('photos/known.webp');
      expect(storage.deleteObject).not.toHaveBeenCalledWith('photos/recent.webp');
    });
  });
});
