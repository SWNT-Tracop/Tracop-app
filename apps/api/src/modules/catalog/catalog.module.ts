import { Module } from '@nestjs/common';
import { SharedInfraModule } from '../../shared/infra/shared-infra.module.js';
import { APP_ENVIRONMENT } from '../../shared/infra/tokens.js';
import type { AppEnvironment } from '../../shared/infra/env.js';
import { CatalogService, CATALOG_SETTINGS } from './application/catalog-service.js';
import { CatalogController, LotsController } from './adapters/in/catalog.controller.js';
import {
  DrizzleCategoryRepository,
  DrizzleLotRepository,
  DrizzleProductRepository,
  DrizzleCatalogUnitOfWork,
  SharedCatalogClock,
  SharedCatalogEventWriter,
} from './adapters/out/drizzle-repositories.js';
import {
  CATALOG_CATEGORY_REPOSITORY,
  CATALOG_CLOCK,
  CATALOG_EVENT_WRITER,
  CATALOG_LOT_REPOSITORY,
  CATALOG_PRODUCT_REPOSITORY,
  CATALOG_UNIT_OF_WORK,
} from './ports/catalog-ports.js';
import { PROVIDER_DIRECTORY } from './ports/catalog-ports.js';

@Module({
  imports: [SharedInfraModule],
  controllers: [CatalogController, LotsController],
  providers: [
    DrizzleCategoryRepository,
    DrizzleProductRepository,
    DrizzleLotRepository,
    DrizzleCatalogUnitOfWork,
    SharedCatalogClock,
    SharedCatalogEventWriter,
    { provide: CATALOG_CATEGORY_REPOSITORY, useExisting: DrizzleCategoryRepository },
    { provide: CATALOG_PRODUCT_REPOSITORY, useExisting: DrizzleProductRepository },
    { provide: CATALOG_LOT_REPOSITORY, useExisting: DrizzleLotRepository },
    { provide: CATALOG_UNIT_OF_WORK, useExisting: DrizzleCatalogUnitOfWork },
    { provide: CATALOG_CLOCK, useExisting: SharedCatalogClock },
    { provide: CATALOG_EVENT_WRITER, useExisting: SharedCatalogEventWriter },
    {
      provide: CATALOG_SETTINGS,
      inject: [APP_ENVIRONMENT],
      useFactory: (env: AppEnvironment) => ({ lotHorizonDays: env.CATALOG_LOT_MAX_HORIZON_DAYS }),
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
      ],
    },
  ],
  exports: [CatalogService],
})
export class CatalogModule {}
