import { isLogisticsStaff } from '../domain/logistics-staff.js';
import { Inject, Injectable } from '@nestjs/common';
import { DomainError } from '../../../shared/kernel/domain-error.js';
import { Carrier } from '../domain/carrier.js';
import type { CarrierProps } from '../domain/carrier.js';
import {
  LOGISTICS_CLOCK,
  LOGISTICS_REPOSITORY,
  LOGISTICS_UNIT_OF_WORK,
  type LogisticsActor,
  type LogisticsClock,
  type LogisticsRepository,
  type LogisticsUnitOfWork,
} from '../ports/logistics-ports.js';

export interface UpsertCarrierInput {
  readonly vehicleType: string;
  readonly capacityKg: number;
  readonly plate: string;
}

@Injectable()
export class CarrierProfileService {
  constructor(
    @Inject(LOGISTICS_REPOSITORY) private readonly repository: LogisticsRepository,
    @Inject(LOGISTICS_UNIT_OF_WORK) private readonly uow: LogisticsUnitOfWork,
    @Inject(LOGISTICS_CLOCK) private readonly clock: LogisticsClock,
  ) {}

  async upsertMine(actor: LogisticsActor, input: UpsertCarrierInput): Promise<CarrierProps> {
    this.requireCarrier(actor);
    return this.uow.run(async () => {
      const existing = await this.repository.findCarrier(actor.sub);
      const now = this.clock.now();
      return this.repository.upsertCarrier(
        Carrier.create({
          userId: actor.sub,
          vehicleType: input.vehicleType,
          capacityKg: input.capacityKg,
          plate: input.plate,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        }).props,
      );
    });
  }

  async getMine(actor: LogisticsActor): Promise<CarrierProps> {
    this.requireCarrier(actor);
    const profile = await this.repository.findCarrier(actor.sub);
    if (!profile) throw new DomainError('Perfil de transportista no encontrado.', 'not_found');
    return profile;
  }

  async list(actor: LogisticsActor, limit = 50): Promise<readonly CarrierProps[]> {
    if (!isLogisticsStaff(actor.role))
      throw new DomainError('Solo el operador puede listar transportistas.', 'invalid_role');
    return this.repository.listCarriers(Math.min(Math.max(limit, 1), 200));
  }

  private requireCarrier(actor: LogisticsActor): void {
    if (actor.role !== 'carrier') throw new DomainError('Solo transportistas.', 'invalid_role');
  }
}
