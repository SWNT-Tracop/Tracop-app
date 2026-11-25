import { Module } from '@nestjs/common';
import { PHOTO_PROCESSOR_PORT } from '../../ports/photo-processor.js';
import { STORAGE_PORT } from '../../ports/storage.js';
import type { AppEnvironment } from '../env.js';
import { SharedInfraModule } from '../shared-infra.module.js';
import { APP_ENVIRONMENT } from '../tokens.js';
import { InMemoryStorageAdapter } from './in-memory-storage.adapter.js';
import { S3StorageAdapter } from './s3-storage.adapter.js';
import { SharpPhotoProcessorAdapter } from './sharp-photo-processor.adapter.js';

/**
 * Object storage and image processing shared by the modules that keep files
 * (lot photos today, payment proofs next). Tests and environments without a
 * bucket use the in-memory adapter.
 */
@Module({
  imports: [SharedInfraModule],
  providers: [
    InMemoryStorageAdapter,
    {
      provide: S3StorageAdapter,
      inject: [APP_ENVIRONMENT],
      useFactory: (env: AppEnvironment) => new S3StorageAdapter(env),
    },
    {
      provide: STORAGE_PORT,
      inject: [APP_ENVIRONMENT, S3StorageAdapter, InMemoryStorageAdapter],
      useFactory: (env: AppEnvironment, s3: S3StorageAdapter, memory: InMemoryStorageAdapter) =>
        env.NODE_ENV === 'test' || !env.S3_BUCKET ? memory : s3,
    },
    {
      provide: PHOTO_PROCESSOR_PORT,
      useFactory: () => new SharpPhotoProcessorAdapter(),
    },
  ],
  exports: [STORAGE_PORT, PHOTO_PROCESSOR_PORT, InMemoryStorageAdapter],
})
export class StorageModule {}
