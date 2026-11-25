import { Module } from '@nestjs/common';
import { SharedInfraModule } from '../../shared/infra/shared-infra.module.js';
import { APP_ENVIRONMENT } from '../../shared/infra/tokens.js';
import type { AppEnvironment } from '../../shared/infra/env.js';
import {
  CatalogService,
  CATALOG_SETTINGS,
  type CatalogSettings,
} from './application/catalog-service.js';
import { DeleteLot } from './application/delete-lot.js';
import { LotPhotoService } from './application/lot-photo-service.js';
import {
  CATALOG_MAINTENANCE,
  CatalogMaintenanceService,
} from './application/catalog-maintenance-service.js';
import { CatalogController, LotsController } from './adapters/in/catalog.controller.js';
import {
  DrizzleCategoryRepository,
  DrizzleLotRepository,
  DrizzleProductRepository,
  DrizzleCatalogUnitOfWork,
  SharedCatalogClock,
  SharedCatalogEventWriter,
} from './adapters/out/drizzle-repositories.js';
import { DrizzleLotPhotoRepository } from './adapters/out/drizzle-lot-photo-repository.js';
import { PhotoUploadRateLimiter } from './adapters/out/photo-upload-rate-limiter.js';
import { InMemoryProductProposalRateLimiter } from './adapters/in/product-proposal-rate-limiter.js';
import {
  CATALOG_CATEGORY_REPOSITORY,
  CATALOG_CLOCK,
  CATALOG_EVENT_WRITER,
  CATALOG_LOT_REPOSITORY,
  CATALOG_METRICS,
  CATALOG_ORDERING_API,
  CATALOG_PRODUCT_REPOSITORY,
  CATALOG_UNIT_OF_WORK,
  CHANGE_RECORDER,
  PROVIDER_DIRECTORY,
} from './ports/catalog-ports.js';
import {
  LOT_PHOTO_REPOSITORY,
  PHOTO_UPLOAD_RATE_LIMIT_PORT,
  type LotPhotoRepository,
  type PhotoUploadRateLimitPort,
} from './ports/lot-photo-ports.js';
import { StorageModule } from '../../shared/infra/storage/storage.module.js';
import { DrizzleCatalogMetricsQuery } from './adapters/out/catalog-metrics-query.js';
import { AUDIT_WRITER } from '../../shared/ports/audit-writer.js';
import { PARAMETER_READER } from '../../shared/ports/parameter-reader.js';
import {
  PHOTO_PROCESSOR_PORT,
  type PhotoProcessorPort,
} from '../../shared/ports/photo-processor.js';
import { STORAGE_PORT, type StoragePort } from '../../shared/ports/storage.js';

@Module({
  imports: [SharedInfraModule, StorageModule],
  controllers: [CatalogController, LotsController],
  providers: [
    DrizzleCategoryRepository,
    DrizzleProductRepository,
    DrizzleLotRepository,
    DrizzleCatalogUnitOfWork,
    DrizzleLotPhotoRepository,
    InMemoryProductProposalRateLimiter,
    SharedCatalogClock,
    SharedCatalogEventWriter,
    DrizzleCatalogMetricsQuery,
    { provide: CATALOG_METRICS, useExisting: DrizzleCatalogMetricsQuery },
    { provide: CATALOG_CATEGORY_REPOSITORY, useExisting: DrizzleCategoryRepository },
    { provide: CATALOG_PRODUCT_REPOSITORY, useExisting: DrizzleProductRepository },
    { provide: CATALOG_LOT_REPOSITORY, useExisting: DrizzleLotRepository },
    { provide: CATALOG_UNIT_OF_WORK, useExisting: DrizzleCatalogUnitOfWork },
    { provide: CATALOG_CLOCK, useExisting: SharedCatalogClock },
    { provide: CATALOG_EVENT_WRITER, useExisting: SharedCatalogEventWriter },
    { provide: LOT_PHOTO_REPOSITORY, useExisting: DrizzleLotPhotoRepository },
    {
      provide: PHOTO_UPLOAD_RATE_LIMIT_PORT,
      inject: [APP_ENVIRONMENT],
      useFactory: (env: AppEnvironment) => new PhotoUploadRateLimiter(env),
    },
    {
      provide: CATALOG_SETTINGS,
      inject: [APP_ENVIRONMENT],
      useFactory: (env: AppEnvironment): CatalogSettings => ({
        lotHorizonDays: env.CATALOG_LOT_MAX_HORIZON_DAYS,
        productProposalPendingLimit: env.CATALOG_PRODUCT_PROPOSAL_PENDING_LIMIT,
      }),
    },
    {
      provide: LotPhotoService,
      inject: [
        LOT_PHOTO_REPOSITORY,
        STORAGE_PORT,
        PHOTO_PROCESSOR_PORT,
        PHOTO_UPLOAD_RATE_LIMIT_PORT,
        APP_ENVIRONMENT,
      ],
      useFactory: (
        photos: LotPhotoRepository,
        storage: StoragePort,
        processor: PhotoProcessorPort,
        rateLimit: PhotoUploadRateLimitPort,
        env: AppEnvironment,
      ) =>
        new LotPhotoService(photos, storage, processor, rateLimit, {
          maxCount: env.CATALOG_PHOTO_MAX_COUNT,
          maxBytes: env.CATALOG_PHOTO_MAX_BYTES,
          maxInputPixels: env.CATALOG_PHOTO_MAX_INPUT_PIXELS,
          maxInputDimension: env.CATALOG_PHOTO_MAX_INPUT_DIMENSION,
          maxOutputDimension: env.CATALOG_PHOTO_MAX_OUTPUT_DIMENSION,
          pendingTtlSeconds: env.CATALOG_PHOTO_PENDING_TTL_SECONDS,
          uploadUrlTtlSeconds: env.CATALOG_PHOTO_UPLOAD_URL_TTL_SECONDS,
          downloadUrlTtlSeconds: env.CATALOG_PHOTO_DOWNLOAD_URL_TTL_SECONDS,
          purgeGraceSeconds: env.CATALOG_PHOTO_PURGE_GRACE_SECONDS,
          webpQuality: env.CATALOG_PHOTO_WEBP_QUALITY,
          conversionConcurrency: env.CATALOG_PHOTO_CONCURRENCY,
          processingLeaseSeconds: env.CATALOG_PHOTO_PROCESSING_LEASE_SECONDS,
        }),
    },
    {
      provide: CatalogService,
      useFactory: (...dependencies: ConstructorParameters<typeof CatalogService>) =>
        new CatalogService(...dependencies),
      inject: [
        CATALOG_CATEGORY_REPOSITORY,
        CATALOG_PRODUCT_REPOSITORY,
        CATALOG_LOT_REPOSITORY,
        CATALOG_UNIT_OF_WORK,
        CATALOG_EVENT_WRITER,
        CATALOG_CLOCK,
        PROVIDER_DIRECTORY,
        CATALOG_SETTINGS,
        CHANGE_RECORDER,
        LOT_PHOTO_REPOSITORY,
        AUDIT_WRITER,
        PARAMETER_READER,
      ],
    },
    {
      provide: CATALOG_ORDERING_API,
      useExisting: CatalogService,
    },
    DeleteLot,
    {
      provide: CATALOG_MAINTENANCE,
      inject: [CatalogService, LotPhotoService],
      useFactory: (catalog: CatalogService, photos: LotPhotoService) =>
        new CatalogMaintenanceService(catalog, photos),
    },
  ],
  exports: [CatalogService, DeleteLot, CATALOG_ORDERING_API, CATALOG_MAINTENANCE, CATALOG_METRICS],
})
export class CatalogModule {}
