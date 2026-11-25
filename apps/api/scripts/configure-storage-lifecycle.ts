/**
 * Lifecycle rules of the photo and proof bucket: uploads never processed or confirmed, under
 * incoming/ (lot photos, pending 30 min) and payment-incoming/ (payment proofs, 15 min to
 * upload), expire after INCOMING_RETENTION_DAYS (1 = 24 h); unfinished multipart uploads are
 * aborted after the same time. photos/ and payment-proofs/ are never touched.
 * Usage: pnpm storage:configure-lifecycle (needs S3_ENDPOINT, S3_BUCKET and S3_ADMIN_* keys).
 */
import {
  type LifecycleRule,
  GetBucketLifecycleConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { z } from 'zod';

export const INCOMING_RULE_ID = 'tracop-expire-incoming';
export const PAYMENT_INCOMING_RULE_ID = 'tracop-expire-payment-incoming';
const RULES = [
  { id: INCOMING_RULE_ID, prefix: 'incoming/' },
  { id: PAYMENT_INCOMING_RULE_ID, prefix: 'payment-incoming/' },
] as const;

export interface StorageLifecycleConfiguration {
  readonly endpoint: string;
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly incomingRetentionDays: number;
}

const environmentSchema = z.object({
  S3_ENDPOINT: z.string().url(),
  S3_BUCKET: z.string().min(3).max(63),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_ADMIN_ACCESS_KEY: z.string().min(1),
  S3_ADMIN_SECRET_KEY: z.string().min(1),
  INCOMING_RETENTION_DAYS: z.coerce.number().int().min(1).max(30).default(1),
});

export const incomingLifecycleRules = (days: number): LifecycleRule[] =>
  RULES.map(({ id, prefix }) => ({
    ID: id,
    Status: 'Enabled',
    Filter: { Prefix: prefix },
    Expiration: { Days: days },
    AbortIncompleteMultipartUpload: { DaysAfterInitiation: days },
  }));
const OUR_IDS = new Set<string>(RULES.map(({ id }) => id));

/** Replaces only our rule, keeps any other rule of the bucket, and reads it back. */
export const configureStorageLifecycle = async (
  configuration: StorageLifecycleConfiguration,
): Promise<void> => {
  const client = new S3Client({
    endpoint: configuration.endpoint,
    region: configuration.region,
    forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    credentials: {
      accessKeyId: configuration.accessKeyId,
      secretAccessKey: configuration.secretAccessKey,
    },
  });
  let others: LifecycleRule[] = [];
  try {
    const current = await client.send(
      new GetBucketLifecycleConfigurationCommand({ Bucket: configuration.bucket }),
    );
    others = (current.Rules ?? []).filter((rule) => !OUR_IDS.has(rule.ID ?? ''));
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'NoSuchLifecycleConfiguration') throw error;
  }
  await client.send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket: configuration.bucket,
      LifecycleConfiguration: {
        Rules: [...others, ...incomingLifecycleRules(configuration.incomingRetentionDays)],
      },
    }),
  );
  const stored = await client.send(
    new GetBucketLifecycleConfigurationCommand({ Bucket: configuration.bucket }),
  );
  for (const { id, prefix } of RULES) {
    const rule = (stored.Rules ?? []).find((candidate) => candidate.ID === id);
    if (
      !rule ||
      rule.Status !== 'Enabled' ||
      rule.Expiration?.Days !== configuration.incomingRetentionDays ||
      (rule.Filter?.Prefix ?? rule.Prefix) !== prefix
    )
      throw new Error(`El bucket no conservó la regla de ciclo de vida de ${prefix}.`);
  }
};

const main = async (): Promise<void> => {
  const parsed = environmentSchema.parse(process.env);
  await configureStorageLifecycle({
    endpoint: parsed.S3_ENDPOINT,
    bucket: parsed.S3_BUCKET,
    region: parsed.S3_REGION,
    accessKeyId: parsed.S3_ADMIN_ACCESS_KEY,
    secretAccessKey: parsed.S3_ADMIN_SECRET_KEY,
    incomingRetentionDays: parsed.INCOMING_RETENTION_DAYS,
  });
  process.stdout.write(
    `Lifecycle configured: incoming/ and payment-incoming/ expire after ${parsed.INCOMING_RETENTION_DAYS} day(s).\n`,
  );
};

if (process.argv[1]?.endsWith('/configure-storage-lifecycle.ts')) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Storage lifecycle configuration failed.'}\n`,
    );
    process.exitCode = 1;
  });
}
