import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { AppEnvironment } from '../../../../shared/infra/env.js';
import type { StorageObjectMetadata, StoragePort } from '../../ports/storage-port.js';

export class S3StorageAdapter implements StoragePort {
  private readonly apiClient: S3Client;
  private readonly policyClient: S3Client;
  private readonly downloadClient: S3Client;

  constructor(private readonly env: AppEnvironment) {
    const publicEndpoint = env.S3_PUBLIC_ENDPOINT ?? env.S3_ENDPOINT;
    const baseOptions = {
      region: env.S3_REGION,
      forcePathStyle: true,
      requestChecksumCalculation: 'WHEN_REQUIRED' as const,
    };
    const apiCredentials = {
      accessKeyId: env.S3_API_ACCESS_KEY ?? '',
      secretAccessKey: env.S3_API_SECRET_KEY ?? '',
    };
    const policyCredentials = {
      accessKeyId: env.S3_POLICY_ACCESS_KEY ?? apiCredentials.accessKeyId,
      secretAccessKey: env.S3_POLICY_SECRET_KEY ?? apiCredentials.secretAccessKey,
    };

    this.apiClient = new S3Client({
      ...baseOptions,
      credentials: apiCredentials,
      ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
    });
    this.policyClient = new S3Client({
      ...baseOptions,
      credentials: policyCredentials,
      ...(publicEndpoint ? { endpoint: publicEndpoint } : {}),
    });
    this.downloadClient = new S3Client({
      ...baseOptions,
      credentials: apiCredentials,
      ...(publicEndpoint ? { endpoint: publicEndpoint } : {}),
    });
  }

  async createUploadPolicy(input: {
    readonly key: string;
    readonly maxBytes: number;
    readonly expiresAt: Date;
  }): Promise<{ url: string; fields: Readonly<Record<string, string>>; expiresAt: Date }> {
    const expiresIn = Math.max(1, Math.floor((input.expiresAt.getTime() - Date.now()) / 1000));
    const policy = await createPresignedPost(this.policyClient, {
      Bucket: this.env.S3_BUCKET ?? '',
      Key: input.key,
      Expires: expiresIn,
      Conditions: [['content-length-range', 1, input.maxBytes]],
    });
    return { url: policy.url, fields: policy.fields, expiresAt: input.expiresAt };
  }

  async headObject(key: string): Promise<StorageObjectMetadata | null> {
    try {
      const result = await this.apiClient.send(
        new HeadObjectCommand({ Bucket: this.env.S3_BUCKET ?? '', Key: key }),
      );
      if (result.ContentLength === undefined || !result.LastModified) return null;
      return {
        key,
        sizeBytes: result.ContentLength,
        ...(result.ContentType ? { contentType: result.ContentType } : {}),
        lastModified: result.LastModified,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw new Error('Storage object inspection failed.');
    }
  }

  async getObject(key: string): Promise<Uint8Array> {
    const result = await this.apiClient.send(
      new GetObjectCommand({ Bucket: this.env.S3_BUCKET ?? '', Key: key }),
    );
    if (!result.Body) throw new Error('Storage object has no body.');
    return result.Body.transformToByteArray();
  }

  async putObject(input: {
    readonly key: string;
    readonly body: Uint8Array;
    readonly contentType: string;
  }): Promise<void> {
    await this.apiClient.send(
      new PutObjectCommand({
        Bucket: this.env.S3_BUCKET ?? '',
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
      }),
    );
  }

  createDownloadUrl(key: string, expiresAt: Date): Promise<string> {
    return getSignedUrl(
      this.downloadClient,
      new GetObjectCommand({ Bucket: this.env.S3_BUCKET ?? '', Key: key }),
      { expiresIn: Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000)) },
    );
  }

  async deleteObject(key: string): Promise<void> {
    await this.apiClient.send(
      new DeleteObjectCommand({ Bucket: this.env.S3_BUCKET ?? '', Key: key }),
    );
  }

  async *listObjects(prefix: string): AsyncIterable<StorageObjectMetadata> {
    let continuationToken: string | undefined;
    do {
      const page = await this.apiClient.send(
        new ListObjectsV2Command({
          Bucket: this.env.S3_BUCKET ?? '',
          Prefix: prefix,
          ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
        }),
      );
      for (const item of page.Contents ?? []) {
        if (!item.Key || item.Size === undefined || !item.LastModified) continue;
        yield { key: item.Key, sizeBytes: item.Size, lastModified: item.LastModified };
      }
      continuationToken = page.NextContinuationToken;
    } while (continuationToken);
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error.name === 'NotFound' || error.name === 'NoSuchKey')
  );
}
