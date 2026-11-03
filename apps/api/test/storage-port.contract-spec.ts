import { InMemoryStorageAdapter } from '../src/modules/catalog/adapters/out/in-memory-storage.adapter.js';
import { randomUUID } from 'node:crypto';
import { storagePortContract } from './support/storage-port-contract.js';

storagePortContract('in memory', async () => {
  const storage = new InMemoryStorageAdapter();
  const keyPrefix = `${randomUUID()}/`;
  return {
    storage,
    keyPrefix,
    upload: (key, bytes) => storage.acceptUpload(key, bytes),
    cleanup: async () => {
      for await (const object of storage.listObjects(keyPrefix))
        await storage.deleteObject(object.key);
    },
  };
});

describe('InMemoryStorageAdapter secure fixture URLs', () => {
  it('uses HTTPS for its upload and download URL fixtures', async () => {
    const storage = new InMemoryStorageAdapter();
    const expiresAt = new Date('2026-11-02T12:15:00.000Z');
    const policy = await storage.createUploadPolicy({
      key: 'incoming/synthetic-key',
      maxBytes: 16,
      expiresAt,
    });
    await storage.acceptUpload('photos/synthetic.webp', new Uint8Array([1]));

    expect(policy.url).toMatch(/^https:\/\//);
    await expect(storage.createDownloadUrl('photos/synthetic.webp', expiresAt)).resolves.toMatch(
      /^https:\/\//,
    );
  });
});
