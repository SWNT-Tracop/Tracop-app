import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { MinioContainer } from '@testcontainers/minio';
import { randomUUID } from 'node:crypto';
import { loadAppEnvironment } from '../src/shared/infra/env.js';
import { S3StorageAdapter } from '../src/shared/infra/storage/s3-storage.adapter.js';
import { storagePortContract } from './support/storage-port-contract.js';
import {
  StorageCorsNotSupportedError,
  configureStorageCors,
} from '../scripts/configure-storage-cors.js';

let storage: S3StorageAdapter;
let container: Awaited<ReturnType<MinioContainer['start']>> | undefined;
let publicEndpoint = '';
let internalEndpointUrl = '';
const describeMinio =
  process.env.TRACOP_TESTCONTAINER_AVAILABLE === 'true' ? describe : describe.skip;

describeMinio('S3StorageAdapter with MinIO Testcontainers', () => {
  beforeAll(async () => {
    container = await new MinioContainer('bitnamilegacy/minio:2025.7.23-debian-12-r5')
      .withUser('root')
      .withUsername('synthetic-root')
      .withPassword('synthetic-root-password')
      .start();
    publicEndpoint = container.getConnectionUrl();
    const internalEndpoint = new URL(publicEndpoint);
    internalEndpoint.hostname = '127.0.0.1';
    internalEndpointUrl = internalEndpoint.toString().replace(/\/$/, '');
    const client = new S3Client({
      endpoint: internalEndpointUrl,
      region: 'us-east-1',
      forcePathStyle: true,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      credentials: {
        accessKeyId: container.getUsername(),
        secretAccessKey: container.getPassword(),
      },
    });
    await client.send(new CreateBucketCommand({ Bucket: 'tracop-test-bucket' }));
    const base = loadAppEnvironment('/tmp/tracop-no-env');
    const env = {
      ...base,
      S3_ENDPOINT: internalEndpoint.toString().replace(/\/$/, ''),
      S3_PUBLIC_ENDPOINT: publicEndpoint,
      S3_BUCKET: 'tracop-test-bucket',
      S3_REGION: 'us-east-1',
      S3_API_ACCESS_KEY: container.getUsername(),
      S3_API_SECRET_KEY: container.getPassword(),
      S3_POLICY_ACCESS_KEY: container.getUsername(),
      S3_POLICY_SECRET_KEY: container.getPassword(),
    };
    storage = new S3StorageAdapter(env);
  }, 120_000);

  afterAll(async () => {
    if (container) await container.stop();
  });

  storagePortContract('MinIO', async () => {
    const keyPrefix = `tests/${randomUUID()}/`;
    return {
      storage,
      keyPrefix,
      expectedSignedEndpoint: publicEndpoint,
      verifySignedPostPolicy: true,
      cleanup: async () => {
        for await (const object of storage.listObjects(keyPrefix)) {
          await storage.deleteObject(object.key);
        }
      },
      upload: async (key, bytes) => {
        const policy = await storage.createUploadPolicy({
          key,
          maxBytes: 16,
          expiresAt: new Date(Date.now() + 60_000),
        });
        const form = new FormData();
        for (const [field, value] of Object.entries(policy.fields)) form.append(field, value);
        const fileBuffer = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(fileBuffer).set(bytes);
        form.append('file', new Blob([fileBuffer]));
        const response = await fetch(policy.url, { method: 'POST', body: form });
        if (!response.ok) throw new Error(`MinIO presigned POST failed (${response.status}).`);
      },
    };
  });

  it('storage:configure-cors reports that MinIO needs server-side CORS', async () => {
    await expect(
      configureStorageCors({
        endpoint: internalEndpointUrl,
        bucket: 'tracop-test-bucket',
        region: 'us-east-1',
        accessKeyId: container!.getUsername(),
        secretAccessKey: container!.getPassword(),
        origins: ['http://localhost:8081'],
      }),
    ).rejects.toBeInstanceOf(StorageCorsNotSupportedError);
  });
});

const preflight = (endpoint: string, origin: string) =>
  fetch(`${endpoint}/tracop-cors-bucket/incoming/probe`, {
    method: 'OPTIONS',
    headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
  });

describeMinio('MinIO server-side CORS (MINIO_API_CORS_ALLOW_ORIGIN, as in docker-compose)', () => {
  let restricted: Awaited<ReturnType<MinioContainer['start']>> | undefined;
  let endpoint = '';
  const allowedOrigin = 'http://localhost:8081';

  beforeAll(async () => {
    restricted = await new MinioContainer('bitnamilegacy/minio:2025.7.23-debian-12-r5')
      .withUser('root')
      .withUsername('synthetic-root')
      .withPassword('synthetic-root-password')
      .withEnvironment({ MINIO_API_CORS_ALLOW_ORIGIN: allowedOrigin })
      .start();
    const url = new URL(restricted.getConnectionUrl());
    url.hostname = '127.0.0.1';
    endpoint = url.toString().replace(/\/$/, '');
    await new S3Client({
      endpoint,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: {
        accessKeyId: restricted.getUsername(),
        secretAccessKey: restricted.getPassword(),
      },
    }).send(new CreateBucketCommand({ Bucket: 'tracop-cors-bucket' }));
  }, 120_000);

  afterAll(async () => {
    if (restricted) await restricted.stop();
  });

  it('answers the preflight of the configured origin and no other', async () => {
    const allowed = await preflight(endpoint, allowedOrigin);
    expect(allowed.headers.get('access-control-allow-origin')).toBe(allowedOrigin);
    const denied = await preflight(endpoint, 'http://evil.example.test');
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });
});
