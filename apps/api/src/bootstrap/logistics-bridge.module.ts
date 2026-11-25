import { Global, Module } from '@nestjs/common';
import {
  IdentityModule,
  ProviderProfileService,
  PROVIDER_PROFILE_SERVICE,
} from '../modules/identity/index.js';
import { OrderingModule, OrderingService, type OrderAggregate } from '../modules/ordering/index.js';
import {
  SYNC_REPOSITORY,
  SyncModule,
  SyncOperationHandlerRegistry,
  type ChangeRecord,
  type SyncRepositoryPort,
} from '../modules/sync/index.js';
import {
  CheckinService,
  CheckinSyncHandler,
  IncidentService,
  TripSyncHandler,
  TripPlanningService,
  IncidentSyncHandler,
  CarrierProfileSyncHandler,
  CarrierProfileService,
  LogisticsModule,
  LOGISTICS_CHANGE_RECORDER,
  ORDERING_LOGISTICS_PORT,
  PROVIDER_ZONE_PORT,
  type ChangeInput,
  type LogisticsActor,
  type LogisticsChangeRecorder,
  type OrderCandidate,
  type OrderingLogisticsPort,
  type ProviderZonePort,
} from '../modules/logistics/index.js';

export class OrderingLogisticsAdapter implements OrderingLogisticsPort {
  constructor(private readonly ordering: OrderingService) {}

  private toCandidate(aggregate: OrderAggregate): OrderCandidate {
    return {
      orderId: aggregate.order.id,
      providerId: aggregate.order.providerId,
      status: aggregate.order.status,
      version: aggregate.order.version,
      deliveryAddress: aggregate.order.deliveryAddress,
      deliveryWindow: aggregate.order.deliveryWindow,
      lines: aggregate.lines.map((line) => ({
        lotId: line.lotId,
        providerId: line.providerId,
        quantityMilli: line.quantityMilli,
        unit: line.unit,
      })),
    };
  }

  async listPickupCandidates(
    actor: LogisticsActor,
    limit: number,
  ): Promise<readonly OrderCandidate[]> {
    const aggregates = await this.ordering.listForLogistics(actor, 'paid', limit);
    return aggregates.map((aggregate) => this.toCandidate(aggregate));
  }

  async getCandidate(actor: LogisticsActor, orderId: string): Promise<OrderCandidate | null> {
    const aggregate = await this.ordering.getForLogistics(actor, orderId);
    return aggregate ? this.toCandidate(aggregate) : null;
  }

  async transition(
    actor: LogisticsActor,
    orderId: string,
    expectedVersion: number,
    next: 'pickup_scheduled' | 'in_transit' | 'delivered',
  ): Promise<void> {
    await this.ordering.transitionForLogistics(actor, orderId, expectedVersion, next);
  }
}

export class ProviderZoneAdapter implements ProviderZonePort {
  constructor(private readonly profiles: ProviderProfileService) {}

  async getZones(providerIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const summaries = await this.profiles.getProviderPublicSummaries(providerIds);
    const zones = new Map<string, string>();
    for (const [id, summary] of summaries) {
      zones.set(
        id,
        (summary.municipality || summary.department || summary.displayName)
          .trim()
          .toLowerCase()
          .replace(/\s+/g, ' '),
      );
    }
    return zones;
  }
}

export class LogisticsChangeRecorderAdapter implements LogisticsChangeRecorder {
  constructor(private readonly sync: SyncRepositoryPort) {}

  record(change: ChangeInput): Promise<string> {
    const record: ChangeRecord = {
      entity: change.entity,
      entityId: change.entityId,
      op: change.op,
      payload: change.payload,
      ownerUserId: change.ownerUserId,
      occurredAt: change.occurredAt,
    };
    return this.sync.appendChange(record);
  }
}

const REGISTER_CHECKIN_SYNC_HANDLER = Symbol('REGISTER_CHECKIN_SYNC_HANDLER');
const REGISTER_LOGISTICS_SYNC_HANDLERS = Symbol('REGISTER_LOGISTICS_SYNC_HANDLERS');

@Global()
@Module({
  imports: [IdentityModule, LogisticsModule, OrderingModule, SyncModule],
  providers: [
    {
      provide: ORDERING_LOGISTICS_PORT,
      inject: [OrderingService],
      useFactory: (ordering: OrderingService) => new OrderingLogisticsAdapter(ordering),
    },
    {
      provide: PROVIDER_ZONE_PORT,
      inject: [PROVIDER_PROFILE_SERVICE],
      useFactory: (profiles: ProviderProfileService) => new ProviderZoneAdapter(profiles),
    },
    {
      provide: LOGISTICS_CHANGE_RECORDER,
      inject: [SYNC_REPOSITORY],
      useFactory: (repository: SyncRepositoryPort) =>
        new LogisticsChangeRecorderAdapter(repository),
    },
    {
      provide: REGISTER_CHECKIN_SYNC_HANDLER,
      inject: [CheckinService, SyncOperationHandlerRegistry],
      useFactory: (checkins: CheckinService, registry: SyncOperationHandlerRegistry) => {
        registry.register(new CheckinSyncHandler(checkins));
        return true;
      },
    },
    {
      provide: REGISTER_LOGISTICS_SYNC_HANDLERS,
      inject: [
        TripPlanningService,
        IncidentService,
        CarrierProfileService,
        SyncOperationHandlerRegistry,
      ],
      useFactory: (
        trips: TripPlanningService,
        incidents: IncidentService,
        profiles: CarrierProfileService,
        registry: SyncOperationHandlerRegistry,
      ) => {
        registry.register(new TripSyncHandler(trips));
        registry.register(new IncidentSyncHandler(incidents));
        registry.register(new CarrierProfileSyncHandler(profiles));
        return true;
      },
    },
  ],
  exports: [ORDERING_LOGISTICS_PORT, PROVIDER_ZONE_PORT, LOGISTICS_CHANGE_RECORDER],
})
export class LogisticsBridgeModule {}
