import { checkinSyncPayloadSchema, type SyncOperationContract } from '@tracop/contracts';
import { DomainError } from '../../../../shared/kernel/domain-error.js';
import type { SyncOperationHandlerPort } from '../../../sync/index.js';
import { CheckinService } from '../../application/checkin.service.js';

export class CheckinSyncHandler implements SyncOperationHandlerPort {
  readonly entity = 'checkin';

  constructor(private readonly checkins: CheckinService) {}

  async handle(
    user: { readonly sub: string; readonly role: string },
    operation: SyncOperationContract,
  ): Promise<{ readonly serverVersion: number }> {
    if (operation.type === 'delete' || operation.type === 'transition')
      throw new DomainError('Transición no soportada para check-in.', 'unsupported_transition');
    const payload = checkinSyncPayloadSchema.parse(operation.payload);
    if (operation.baseVersion === undefined)
      throw new DomainError('baseVersion requerido.', 'invalid_payload');

    await this.checkins.record(
      user,
      {
        id: operation.entityId,
        stopId: payload.stopId,
        kind: payload.kind,
        clientAt: new Date(payload.clientAt),
        ...(payload.mediaRef !== undefined ? { mediaRef: payload.mediaRef } : {}),
      },
      operation.baseVersion,
    );
    return { serverVersion: await this.checkins.getTripVersion(payload.stopId, user) };
  }
}
