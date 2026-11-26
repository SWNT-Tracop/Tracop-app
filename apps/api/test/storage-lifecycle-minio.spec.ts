import {
  CreateBucketCommand,
  GetBucketLifecycleConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { MinioContainer, type StartedMinioContainer } from '@testcontainers/minio';
import {
  configureStorageLifecycle,
  INCOMING_RULE_ID,
  PAYMENT_INCOMING_RULE_ID,
} from '../scripts/configure-storage-lifecycle.js';

const describeMinio =
  process.env.TRACOP_TESTCONTAINER_AVAILABLE === 'true' ? describe : describe.skip;
const BUCKET = 'tracop-lifecycle-bucket';

describeMinio('storage:configure-lifecycle against MinIO (Testcontainers)', () => {
  let container: StartedMinioContainer;
  let client: S3Client;
  let endpoint: string;

  beforeAll(async () => {
    container = await new MinioContainer('bitnamilegacy/minio:2025.7.23-debian-12-r5')
      .withUser('root')
      .withUsername('synthetic-root')
      .withPassword('synthetic-root-password')
      .start();
    const url = new URL(container.getConnectionUrl());
    if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
    endpoint = url.toString().replace(/\/$/, '');
    client = new S3Client({
      endpoint,
      region: 'us-east-1',
      forcePathStyle: true,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      credentials: {
        accessKeyId: container.getUsername(),
        secretAccessKey: container.getPassword(),
      },
    });
    await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
  }, 120_000);

  afterAll(async () => container?.stop());

  const configure = (days = 1) =>
    configureStorageLifecycle({
      endpoint,
      bucket: BUCKET,
      region: 'us-east-1',
      accessKeyId: container.getUsername(),
      secretAccessKey: container.getPassword(),
      incomingRetentionDays: days,
    });

  it('expires incoming/ and payment-incoming/ after 24 h, keeps other rules and is idempotent', async () => {
    await client.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: BUCKET,
        LifecycleConfiguration: {
          Rules: [
            {
              ID: 'other-rule',
              Status: 'Enabled',
              Filter: { Prefix: 'tmp/' },
              Expiration: { Days: 7 },
            },
          ],
        },
      }),
    );
    await configure();
    await configure(); // running it again changes nothing
    const { Rules = [] } = await client.send(
      new GetBucketLifecycleConfigurationCommand({ Bucket: BUCKET }),
    );
    const byId = new Map(Rules.map((rule) => [rule.ID, rule]));
    expect([...byId.keys()].sort()).toEqual(
      ['other-rule', INCOMING_RULE_ID, PAYMENT_INCOMING_RULE_ID].sort(),
    );
    expect(byId.get(INCOMING_RULE_ID)).toMatchObject({
      Status: 'Enabled',
      Expiration: { Days: 1 },
    });
    expect(byId.get(INCOMING_RULE_ID)?.Filter?.Prefix).toBe('incoming/');
    expect(byId.get(PAYMENT_INCOMING_RULE_ID)).toMatchObject({
      Status: 'Enabled',
      Expiration: { Days: 1 },
    });
    expect(byId.get(PAYMENT_INCOMING_RULE_ID)?.Filter?.Prefix).toBe('payment-incoming/');
    expect(byId.get('other-rule')?.Expiration?.Days).toBe(7);
  }, 60_000);
});
