import type { StoragePort } from '../../src/modules/catalog/ports/storage-port.js';

export type StorageFixture = {
  readonly storage: StoragePort;
  readonly keyPrefix: string;
  upload(key: string, bytes: Uint8Array): Promise<void>;
  cleanup(): Promise<void>;
};

export const storagePortContract = (
  name: string,
  createFixture: () => Promise<StorageFixture>,
): void => {
  describe(`StoragePort contract (${name})`, () => {
    let fixture: StorageFixture;

    beforeEach(async () => {
      fixture = await createFixture();
    });
    afterEach(async () => fixture.cleanup());

    it('prepares bounded uploads, verifies, reads, signs, lists, writes, and deletes private objects', async () => {
      const key = `${fixture.keyPrefix}incoming/opaque-key`;
      const bytes = new Uint8Array([1, 2, 3, 4]);
      const expiresAt = new Date(Date.now() + 60_000);
      const policy = await fixture.storage.createUploadPolicy({ key, maxBytes: 16, expiresAt });
      expect(policy.expiresAt).toEqual(expiresAt);
      await fixture.upload(key, bytes);

      await expect(fixture.storage.headObject(key)).resolves.toMatchObject({
        key,
        sizeBytes: 4,
      });
      await expect(fixture.storage.getObject(key)).resolves.toEqual(bytes);
      await expect(fixture.storage.createDownloadUrl(key, expiresAt)).resolves.toContain(
        key.split('/').at(-1),
      );

      const listed: string[] = [];
      for await (const object of fixture.storage.listObjects(`${fixture.keyPrefix}incoming/`)) {
        listed.push(object.key);
      }
      expect(listed).toContain(key);

      await fixture.storage.putObject({
        key: `${fixture.keyPrefix}photos/finished.webp`,
        body: bytes,
        contentType: 'image/webp',
      });
      await expect(
        fixture.storage.headObject(`${fixture.keyPrefix}photos/finished.webp`),
      ).resolves.toMatchObject({
        contentType: 'image/webp',
      });
      await fixture.storage.deleteObject(key);
      await expect(fixture.storage.headObject(key)).resolves.toBeNull();
    });
  });
};
