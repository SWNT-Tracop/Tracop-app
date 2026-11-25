import { createTripSchema, type SyncOperationContract } from '@tracop/contracts';
import { DomainError } from '../../../../shared/kernel/domain-error.js';
import type { SyncOperationHandlerPort } from '../../../sync/index.js';
import { TripPlanningService } from '../../application/trip-planning.service.js';

export class TripSyncHandler implements SyncOperationHandlerPort {
  readonly entity = 'trip';

  constructor(private readonly trips: TripPlanningService) {}

  async handle(
    user: { readonly sub: string; readonly role: string },
    operation: SyncOperationContract,
  ): Promise<{ readonly serverVersion: number }> {
    if (operation.type === 'create') {
      const input = createTripSchema.parse({
        ...operation.payload,
        id: operation.entityId,
      });
      const trip = await this.trips.createTrip(user, input);
      return { serverVersion: trip.version };
    }
    if (operation.type === 'transition') {
      const action = operation.payload['action'];
      if (action !== 'start' || operation.baseVersion === undefined)
        throw new DomainError('Transición de viaje inválida.', 'invalid_payload');
      const trip = await this.trips.start(user, operation.entityId, operation.baseVersion);
      return { serverVersion: trip.version };
    }
    throw new DomainError('Operación de viaje no soportada.', 'unsupported_transition');
  }
}
