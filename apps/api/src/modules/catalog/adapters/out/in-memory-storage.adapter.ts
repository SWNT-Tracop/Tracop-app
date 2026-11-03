import type { StorageObjectMetadata, StoragePort } from '../../ports/storage-port.js';

export class InMemoryStorageAdapter implements StoragePort {
  private readonly objects = new Map<
    string,
    { bytes: Uint8Array; contentType: string; lastModified: Date }
  >();

  async createUploadPolicy(input: {
    readonly key: string;
    readonly maxBytes: number;
    readonly expiresAt: Date;
  }): Promise<{ url: string; fields: Readonly<Record<string, string>>; expiresAt: Date }> {
    return {
      url: 'http://memory.invalid/upload',
      fields: { key: input.key, maxBytes: String(input.maxBytes) },
      expiresAt: input.expiresAt,
    };
  }

  async headObject(key: string): Promise<StorageObjectMetadata | null> {
    const object = this.objects.get(key);
    return object
      ? {
          key,
          sizeBytes: object.bytes.byteLength,
          contentType: object.contentType,
          lastModified: object.lastModified,
        }
      : null;
  }

  async getObject(key: string): Promise<Uint8Array> {
    const object = this.objects.get(key);
    if (!object) throw new Error('Object not found.');
    return object.bytes.slice();
  }

  async putObject(input: {
    readonly key: string;
    readonly body: Uint8Array;
    readonly contentType: string;
  }): Promise<void> {
    this.objects.set(input.key, {
      bytes: input.body.slice(),
      contentType: input.contentType,
      lastModified: new Date(),
    });
  }

  async createDownloadUrl(key: string, expiresAt: Date): Promise<string> {
    if (!this.objects.has(key)) throw new Error('Object not found.');
    return `http://memory.invalid/${key}?expires=${expiresAt.toISOString()}`;
  }

  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async *listObjects(prefix: string): AsyncIterable<StorageObjectMetadata> {
    for (const key of this.objects.keys()) {
      if (key.startsWith(prefix)) {
        const metadata = await this.headObject(key);
        if (metadata) yield metadata;
      }
    }
  }

  async acceptUpload(
    key: string,
    bytes: Uint8Array,
    contentType = 'application/octet-stream',
    lastModified = new Date(),
  ): Promise<void> {
    this.objects.set(key, {
      bytes: bytes.slice(),
      contentType,
      lastModified,
    });
  }
}
