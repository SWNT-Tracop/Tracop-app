import { z } from 'zod';
import { GetBucketCorsCommand, PutBucketCorsCommand, S3Client } from '@aws-sdk/client-s3';

export interface StorageCorsConfiguration {
  readonly endpoint: string;
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly origins: readonly string[];
}

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  S3_ENDPOINT: z.string().url(),
  S3_BUCKET: z.string().min(3).max(63),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_ADMIN_ACCESS_KEY: z.string().min(1),
  S3_ADMIN_SECRET_KEY: z.string().min(1),
  CORS_ALLOWED_ORIGINS: z.string().trim().min(1),
});

export const validateCorsOrigins = (
  origins: readonly string[],
  nodeEnv: 'development' | 'test' | 'production',
): void => {
  for (const origin of origins) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error(`CORS_ALLOWED_ORIGINS contiene un origen inválido: ${origin}`);
    }
    if (origin.includes('*')) throw new Error('CORS_ALLOWED_ORIGINS no admite comodines.');
    if (origin !== url.origin)
      throw new Error('CORS_ALLOWED_ORIGINS solo admite orígenes, sin ruta.');
    if (nodeEnv === 'production' && url.protocol !== 'https:')
      throw new Error('Production requires HTTPS CORS origins.');
    if (nodeEnv === 'development' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1')
      throw new Error('Development CORS origins must use localhost or 127.0.0.1.');
  }
};

export class StorageCorsNotSupportedError extends Error {
  override readonly name = 'StorageCorsNotSupportedError';
  constructor() {
    super(
      'El almacenamiento no admite CORS por bucket (MinIO). Configura los orígenes en el servidor con ' +
        'MINIO_API_CORS_ALLOW_ORIGIN; en docker-compose se toma de MINIO_CORS_ALLOWED_ORIGINS.',
    );
  }
}

export const configureStorageCors = async (
  configuration: StorageCorsConfiguration,
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
  const rules = [
    {
      AllowedOrigins: [...configuration.origins],
      AllowedMethods: ['POST', 'GET', 'HEAD'],
      AllowedHeaders: ['*'],
      ExposeHeaders: ['ETag'],
      MaxAgeSeconds: 600,
    },
  ];
  try {
    await client.send(
      new PutBucketCorsCommand({
        Bucket: configuration.bucket,
        CORSConfiguration: { CORSRules: rules },
      }),
    );
  } catch (error) {
    // MinIO does not implement per-bucket CORS: its CORS is a server setting.
    if (error instanceof Error && error.name === 'NotImplemented')
      throw new StorageCorsNotSupportedError();
    throw error;
  }
  const stored = await client.send(new GetBucketCorsCommand({ Bucket: configuration.bucket }));
  const storedOrigins = (stored.CORSRules ?? []).flatMap((rule) => rule.AllowedOrigins ?? []);
  if ([...configuration.origins].sort().join(',') !== [...storedOrigins].sort().join(','))
    throw new Error('El bucket no conservó los orígenes CORS configurados.');
};

const main = async (): Promise<void> => {
  const parsed = environmentSchema.parse(process.env);
  const origins = parsed.CORS_ALLOWED_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  validateCorsOrigins(origins, parsed.NODE_ENV);
  await configureStorageCors({
    endpoint: parsed.S3_ENDPOINT,
    bucket: parsed.S3_BUCKET,
    region: parsed.S3_REGION,
    accessKeyId: parsed.S3_ADMIN_ACCESS_KEY,
    secretAccessKey: parsed.S3_ADMIN_SECRET_KEY,
    origins,
  });
  process.stdout.write('MinIO bucket CORS configured.\n');
};

if (process.argv[1]?.endsWith('/configure-storage-cors.ts')) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Storage CORS configuration failed.'}\n`,
    );
    process.exitCode = 1;
  });
}
