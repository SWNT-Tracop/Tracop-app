import { carrierProfileSchema, type SyncOperationContract } from '@tracop/contracts';
import { DomainError } from '../../../../shared/kernel/domain-error.js';
import type { SyncOperationHandlerPort } from '../../../sync/index.js';
import { CarrierProfileService } from '../../application/carrier-profile.service.js';

export class CarrierProfileSyncHandler implements SyncOperationHandlerPort {
  readonly entity = 'carrier_profile';

  constructor(private readonly profiles: CarrierProfileService) {}

  async handle(
    user: { readonly sub: string; readonly role: string },
    operation: SyncOperationContract,
  ): Promise<{ readonly serverVersion: number }> {
    if (
      (operation.type !== 'create' && operation.type !== 'update') ||
      operation.entityId !== user.sub
    ) {
      throw new DomainError('Operación de perfil inválida.', 'invalid_payload');
    }
    const input = carrierProfileSchema.parse(operation.payload);
    await this.profiles.upsertMine(user, input);
    return { serverVersion: 1 };
  }
}
