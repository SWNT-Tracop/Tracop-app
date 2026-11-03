import type { StoragePort } from '../../src/modules/catalog/ports/storage-port.js';

export type StorageFixture = {
  readonly storage: StoragePort;
  readonly keyPrefix: string;
  readonly expectedSignedEndpoint?: string;
  readonly verifySignedPostPolicy?: boolean;
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
      const policyStartedAt = Date.now();
      const expiresAt = new Date(policyStartedAt + 15 * 60_000);
      const policy = await fixture.storage.createUploadPolicy({ key, maxBytes: 16, expiresAt });
      expect(policy.expiresAt).toEqual(expiresAt);
      if (fixture.expectedSignedEndpoint) {
        expect(policy.url).toMatch(new RegExp(`^${escapeRegExp(fixture.expectedSignedEndpoint)}`));
      }
      expect(policy.fields.key).toBe(key);
      if (fixture.verifySignedPostPolicy) {
        const signedPolicy = JSON.parse(
          Buffer.from(policy.fields.Policy!, 'base64').toString('utf8'),
        ) as { expiration: string; conditions: unknown[] };
        expect(
          Math.abs(new Date(signedPolicy.expiration).getTime() - expiresAt.getTime()),
        ).toBeLessThan(2_000);
        expect(signedPolicy.conditions).toContainEqual({ key });
        expect(signedPolicy.conditions).toContainEqual(['content-length-range', 1, 16]);
      }
      await fixture.upload(key, bytes);

      await expect(fixture.storage.headObject(key)).resolves.toMatchObject({
        key,
        sizeBytes: 4,
      });
      await expect(fixture.storage.getObject(key)).resolves.toEqual(bytes);
      const processedKey = `${fixture.keyPrefix}photos/finished.webp`;
      await fixture.storage.putObject({
        key: processedKey,
        body: bytes,
        contentType: 'image/webp',
      });
      const downloadUrl = await fixture.storage.createDownloadUrl(processedKey, expiresAt);
      if (fixture.expectedSignedEndpoint) {
        expect(downloadUrl).toMatch(new RegExp(`^${escapeRegExp(fixture.expectedSignedEndpoint)}`));
      }
      expect(downloadUrl).toContain('finished.webp');
      expect(downloadUrl).not.toContain('/incoming/');

      const listed: string[] = [];
      for await (const object of fixture.storage.listObjects(`${fixture.keyPrefix}incoming/`)) {
        listed.push(object.key);
      }
      expect(listed).toContain(key);

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

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
