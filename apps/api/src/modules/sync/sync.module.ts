import { Module } from '@nestjs/common';
import { SharedInfraModule } from '../../shared/infra/shared-infra.module.js';
import { SyncController } from './adapters/in/sync.controller.js';
import { DrizzleSyncRepository } from './adapters/out/drizzle-sync-repository.js';
import { InMemorySyncRateLimiter } from './adapters/out/in-memory-sync-rate-limiter.js';
import { SyncUnitOfWork } from './adapters/out/sync-unit-of-work.js';
import { SyncOperationHandlerRegistry } from './application/sync-operation-handler-registry.js';
import { SyncService } from './application/sync-service.js';
import { SYNC_RATE_LIMIT, SYNC_REPOSITORY, SYNC_UNIT_OF_WORK } from './ports/sync-ports.js';

@Module({
  imports: [SharedInfraModule],
  controllers: [SyncController],
  providers: [
    DrizzleSyncRepository,
    SyncUnitOfWork,
    InMemorySyncRateLimiter,
    SyncOperationHandlerRegistry,
    { provide: SYNC_REPOSITORY, useExisting: DrizzleSyncRepository },
    { provide: SYNC_UNIT_OF_WORK, useExisting: SyncUnitOfWork },
    { provide: SYNC_RATE_LIMIT, useExisting: InMemorySyncRateLimiter },
    SyncService,
  ],
  exports: [SYNC_REPOSITORY, SyncOperationHandlerRegistry, SyncService],
})
export class SyncModule {}
