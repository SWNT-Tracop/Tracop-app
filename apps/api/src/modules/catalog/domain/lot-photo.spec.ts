import { LotPhoto } from './lot-photo.js';

const pendingPhoto = () =>
  LotPhoto.createPending({
    id: '0190f47a-8b45-7cc2-9a1e-123456789abc',
    lotId: '0190f47a-8b45-7cc2-9a1e-123456789abd',
    mediaRef: 'incoming/random-object-key',
    state: 'pending',
    contentType: null,
    sizeBytes: null,
    position: 1,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    expiresAt: new Date('2026-01-01T00:30:00.000Z'),
    leaseToken: null,
    leaseExpiresAt: null,
    deletedAt: null,
  });

describe('LotPhoto', () => {
  it('accepts a client-generated UUID v7 pending photo with a random incoming key', () => {
    expect(pendingPhoto().props.state).toBe('pending');
  });

  it('rejects non-v7 IDs and keys outside incoming', () => {
    expect(() =>
      LotPhoto.createPending({
        ...pendingPhoto().props,
        id: '018f47a2-8b45-4cc2-9a1e-123456789abc',
      }),
    ).toThrow('UUID v7');
    expect(() =>
      LotPhoto.createPending({ ...pendingPhoto().props, mediaRef: 'photos/random-object-key' }),
    ).toThrow('incoming');
    expect(() => LotPhoto.createPending({ ...pendingPhoto().props, position: 0 })).toThrow(
      'positive integer',
    );
  });

  it('reconstitutes persisted states without re-validating the incoming prefix', () => {
    const ready = LotPhoto.reconstitute({
      ...pendingPhoto().props,
      mediaRef: 'photos/processed-object.webp',
      state: 'ready',
      contentType: 'image/webp',
      sizeBytes: 128,
    });
    expect(ready.props.state).toBe('ready');
    expect(ready.isExpiredAt(new Date('2030-01-01T00:00:00.000Z'))).toBe(false);
  });

  it('only treats pending rows as expired once their expiry is reached', () => {
    const photo = pendingPhoto();
    const expiry = photo.props.expiresAt;
    expect(photo.isExpiredAt(new Date(expiry.getTime() - 1))).toBe(false);
    expect(photo.isExpiredAt(expiry)).toBe(true);
    expect(photo.isExpiredAt(new Date(expiry.getTime() + 1))).toBe(true);
  });
});
