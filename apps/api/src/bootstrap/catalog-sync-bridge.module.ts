import { Global, Module } from '@nestjs/common';
import {
  CatalogModule,
  CatalogService,
  CHANGE_RECORDER,
  type ChangeRecorderPort,
} from '../modules/catalog/index.js';
import {
  SYNC_REPOSITORY,
  SyncModule,
  SyncOperationHandlerRegistry,
  type ChangeRecord,
  type SyncRepositoryPort,
} from '../modules/sync/index.js';
import { CatalogLotSyncHandler } from './catalog-lot-sync-handler.js';

export class CatalogChangeRecorderAdapter implements ChangeRecorderPort {
  constructor(private readonly sync: SyncRepositoryPort) {}
  record(change: ChangeRecord): Promise<string> {
    return this.sync.appendChange(change);
  }
  recordBaselineIfAbsent(change: ChangeRecord): Promise<string | null> {
    return this.sync.appendBaselineIfAbsent(change);
  }
}

const REGISTER_CATALOG_LOT_SYNC_HANDLER = Symbol('REGISTER_CATALOG_LOT_SYNC_HANDLER');

@Global()
@Module({
  imports: [CatalogModule, SyncModule],
  providers: [
    {
      provide: CHANGE_RECORDER,
      inject: [SYNC_REPOSITORY],
      useFactory: (repository: SyncRepositoryPort) => new CatalogChangeRecorderAdapter(repository),
    },
    {
      provide: REGISTER_CATALOG_LOT_SYNC_HANDLER,
      inject: [CatalogService, SyncOperationHandlerRegistry],
      useFactory: (catalog: CatalogService, registry: SyncOperationHandlerRegistry) => {
        registry.register(new CatalogLotSyncHandler(catalog));
        return true;
      },
    },
  ],
  exports: [CHANGE_RECORDER],
})
export class CatalogSyncBridgeModule {}
