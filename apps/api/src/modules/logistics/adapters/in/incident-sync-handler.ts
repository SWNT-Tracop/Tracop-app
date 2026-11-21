import { openIncidentSchema, type SyncOperationContract } from '@tracop/contracts';
import { DomainError } from '../../../../shared/kernel/domain-error.js';
import type { SyncOperationHandlerPort } from '../../../sync/index.js';
import { IncidentService } from '../../application/incident.service.js';

export class IncidentSyncHandler implements SyncOperationHandlerPort {
  readonly entity = 'incident';

  constructor(private readonly incidents: IncidentService) {}

  async handle(
    user: { readonly sub: string; readonly role: string },
    operation: SyncOperationContract,
  ): Promise<{ readonly serverVersion: number }> {
    if (operation.type !== 'create')
      throw new DomainError('Solo se pueden crear incidencias.', 'unsupported_transition');
    const input = openIncidentSchema.parse({
      ...operation.payload,
      id: operation.entityId,
    });
    await this.incidents.open(user, {
      id: input.id,
      orderId: input.orderId,
      type: input.type,
      description: input.description,
      ...(input.tripId === undefined ? {} : { tripId: input.tripId }),
    });
    return { serverVersion: 1 };
  }
}
