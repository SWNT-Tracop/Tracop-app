import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { MinioContainer } from '@testcontainers/minio';
import { randomUUID } from 'node:crypto';
import { loadAppEnvironment } from '../src/shared/infra/env.js';
import { S3StorageAdapter } from '../src/modules/catalog/adapters/out/s3-storage.adapter.js';
import { storagePortContract } from './support/storage-port-contract.js';

let storage: S3StorageAdapter;
let container: Awaited<ReturnType<MinioContainer['start']>> | undefined;
const describeMinio =
  process.env.TRACOP_TESTCONTAINER_AVAILABLE === 'true' ? describe : describe.skip;

describeMinio('S3StorageAdapter with MinIO Testcontainers', () => {
  beforeAll(async () => {
    container = await new MinioContainer('bitnamilegacy/minio:2025.7.23-debian-12-r5')
      .withUser('root')
      .withUsername('synthetic-root')
      .withPassword('synthetic-root-password')
      .start();
    const endpoint = container.getConnectionUrl();
    const client = new S3Client({
      endpoint,
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
      S3_ENDPOINT: endpoint,
      S3_PUBLIC_ENDPOINT: endpoint,
      S3_BUCKET: 'tracop-test-bucket',
      S3_REGION: 'us-east-1',
      S3_API_ACCESS_KEY: container.getUsername(),
      S3_API_SECRET_KEY: container.getPassword(),
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
});
