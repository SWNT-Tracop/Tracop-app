export type StorageObjectMetadata = {
  readonly key: string;
  readonly sizeBytes: number;
  readonly contentType?: string;
  readonly lastModified: Date;
};

export type UploadPolicy = {
  readonly url: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly expiresAt: Date;
  readonly objectKey: string;
};

export interface StoragePort {
  createUploadPolicy(input: {
    readonly key: string;
    readonly maxBytes: number;
    readonly expiresAt: Date;
  }): Promise<Omit<UploadPolicy, 'objectKey'>>;
  headObject(key: string): Promise<StorageObjectMetadata | null>;
  getObject(key: string): Promise<Uint8Array>;
  putObject(input: {
    readonly key: string;
    readonly body: Uint8Array;
    readonly contentType: string;
  }): Promise<void>;
  createDownloadUrl(key: string, expiresAt: Date): Promise<string>;
  deleteObject(key: string): Promise<void>;
  listObjects(prefix: string): AsyncIterable<StorageObjectMetadata>;
}

export const STORAGE_PORT = Symbol('STORAGE_PORT');
