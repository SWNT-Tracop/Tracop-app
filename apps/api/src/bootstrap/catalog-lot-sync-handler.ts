import {
  createLotSchema,
  lotSyncTransitionSchema,
  updateLotRequestSchema,
} from '@tracop/contracts';
import { DomainError } from '../shared/kernel/domain-error.js';
import { CatalogService } from '../modules/catalog/index.js';
import type { SyncOperationContract } from '@tracop/contracts';
import type { SyncOperationHandlerPort } from '../modules/sync/index.js';

export class CatalogLotSyncHandler implements SyncOperationHandlerPort {
  readonly entity = 'lot';

  constructor(private readonly catalog: CatalogService) {}

  async handle(
    user: { readonly sub: string; readonly role: string },
    operation: SyncOperationContract,
  ): Promise<{ readonly serverVersion: number }> {
    try {
      if (operation.type === 'create') {
        const input = createLotSchema.parse(operation.payload);
        if (input.id !== operation.entityId)
          throw new DomainError('Payload inválido.', 'invalid_payload');
        const lot = await this.catalog.createLot(user, {
          ...input,
          quantityMilli: BigInt(input.quantityMilli),
          unitPrice: BigInt(input.unitPrice),
          availableFrom: new Date(input.availableFrom),
          availableUntil: new Date(input.availableUntil),
        });
        return { serverVersion: lot.version };
      }

      if (operation.type === 'update') {
        if (operation.baseVersion === undefined)
          throw new DomainError('baseVersion requerido.', 'invalid_payload');
        const input = updateLotRequestSchema.parse({
          ...operation.payload,
          version: operation.baseVersion,
        });
        const patch = {
          ...(input.productId !== undefined ? { productId: input.productId } : {}),
          ...(input.quantityMilli !== undefined
            ? { quantityMilli: BigInt(input.quantityMilli) }
            : {}),
          ...(input.unit !== undefined ? { unit: input.unit } : {}),
          ...(input.unitPrice !== undefined ? { unitPrice: BigInt(input.unitPrice) } : {}),
          ...(input.qualityGrade !== undefined ? { qualityGrade: input.qualityGrade } : {}),
          ...(input.availableFrom !== undefined
            ? { availableFrom: new Date(input.availableFrom) }
            : {}),
          ...(input.availableUntil !== undefined
            ? { availableUntil: new Date(input.availableUntil) }
            : {}),
          ...(input.locationLat !== undefined ? { locationLat: input.locationLat } : {}),
          ...(input.locationLng !== undefined ? { locationLng: input.locationLng } : {}),
        };
        const lot = await this.catalog.updateLot(user, operation.entityId, input.version, patch);
        return { serverVersion: lot.version };
      }

      if (operation.type === 'transition') {
        if (operation.baseVersion === undefined)
          throw new DomainError('baseVersion requerido.', 'invalid_payload');
        const { status } = lotSyncTransitionSchema.parse(operation.payload);
        if (status === 'reserved' || status === 'sold_out' || status === 'expired')
          throw new DomainError('Transición no disponible para sync.', 'unsupported_transition');
        const lot =
          status === 'published'
            ? await this.catalog.publishLot(user, operation.entityId, operation.baseVersion)
            : await this.catalog.cancelLot(user, operation.entityId, operation.baseVersion);
        return { serverVersion: lot.version };
      }

      if (operation.baseVersion === undefined)
        throw new DomainError('baseVersion requerido.', 'invalid_payload');
      const lot = await this.catalog.deleteLot(user, operation.entityId, operation.baseVersion);
      return { serverVersion: lot.version };
    } catch (error) {
      if (error instanceof DomainError && error.code === 'version_conflict') {
        const current = await this.catalog.getOwnedLot(user, operation.entityId).catch(() => null);
        const conflict = new DomainError(
          'Conflicto de versión.',
          'version_conflict',
        ) as DomainError & {
          serverVersion?: number;
        };
        if (current) conflict.serverVersion = current.version;
        throw conflict;
      }
      throw error;
    }
  }
}
