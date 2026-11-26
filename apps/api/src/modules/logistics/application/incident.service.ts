import { isLogisticsStaff } from '../domain/logistics-staff.js';
import { Inject, Injectable } from '@nestjs/common';
import { OUTBOX_WRITER } from '../../../shared/ports/outbox-writer.js';
import type { OutboxWriter } from '../../../shared/ports/outbox-writer.js';
import { AUDIT_WRITER, type AuditWriter } from '../../../shared/ports/audit-writer.js';
import { DomainError } from '../../../shared/kernel/domain-error.js';
import { Incident } from '../domain/incident.js';
import type { IncidentProps } from '../domain/incident.js';
import {
  LOGISTICS_CLOCK,
  LOGISTICS_REPOSITORY,
  LOGISTICS_UNIT_OF_WORK,
  type LogisticsActor,
  type LogisticsClock,
  type LogisticsRepository,
  type LogisticsUnitOfWork,
} from '../ports/logistics-ports.js';

export interface OpenIncidentInput {
  readonly id: string;
  readonly orderId: string;
  readonly tripId?: string;
  readonly type: string;
  readonly description: string;
}

@Injectable()
export class IncidentService {
  constructor(
    @Inject(LOGISTICS_REPOSITORY) private readonly repository: LogisticsRepository,
    @Inject(LOGISTICS_UNIT_OF_WORK) private readonly uow: LogisticsUnitOfWork,
    @Inject(LOGISTICS_CLOCK) private readonly clock: LogisticsClock,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriter,
    // Injected by Nest (global backoffice module); the default only serves hand-built tests.
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter = { record: async () => undefined },
  ) {}

  async open(actor: LogisticsActor, input: OpenIncidentInput): Promise<IncidentProps> {
    this.requireCarrierOrOperator(actor);
    return this.uow.run(async () => {
      if (actor.role === 'carrier') {
        if (!input.tripId) {
          throw new DomainError(
            'El transportista debe asociar la incidencia a un viaje.',
            'not_found',
          );
        }
        const trip = await this.repository.findTrip(input.tripId);
        if (!trip || trip.carrierId !== actor.sub) {
          throw new DomainError('Viaje no encontrado.', 'not_found');
        }
        const stops = await this.repository.findStopsByTrip(input.tripId);
        if (!stops.some((stop) => stop.orderId === input.orderId)) {
          throw new DomainError('Pedido no encontrado en el viaje.', 'not_found');
        }
      }
      const now = this.clock.now();
      const incident = await this.repository.createIncident(
        Incident.create({
          id: input.id,
          orderId: input.orderId,
          tripId: input.tripId ?? null,
          type: input.type,
          description: input.description,
          status: 'open',
          openedAt: now,
          closedAt: null,
          deletedAt: null,
        }).props,
      );
      await this.outbox.append([
        {
          aggregate: 'incident',
          type: 'IncidentOpened',
          payload: { incidentId: incident.id, orderId: incident.orderId },
        },
      ]);
      return incident;
    });
  }

  async resolve(actor: LogisticsActor, incidentId: string): Promise<IncidentProps> {
    this.requireCarrierOrOperator(actor);
    return this.uow.run(async () => {
      const current = await this.repository.findIncident(incidentId);
      if (!current) throw new DomainError('Incidencia no encontrada.', 'not_found');
      if (actor.role === 'carrier') {
        if (!current.tripId) throw new DomainError('Incidencia no encontrada.', 'not_found');
        const trip = await this.repository.findTrip(current.tripId);
        if (!trip || trip.carrierId !== actor.sub)
          throw new DomainError('Incidencia no encontrada.', 'not_found');
      }
      const entity = Incident.reconstitute(current);
      entity.resolve(this.clock.now());
      const saved = await this.repository.resolveIncident(incidentId, entity.props.closedAt!);
      if (!saved) throw new DomainError('Incidencia no encontrada.', 'not_found');
      await this.outbox.append([
        {
          aggregate: 'incident',
          type: 'IncidentResolved',
          payload: { incidentId: saved.id, orderId: saved.orderId },
        },
      ]);
      if (isLogisticsStaff(actor.role))
        await this.audit.record({
          actorId: actor.sub,
          actorRole: actor.role,
          action: 'incident.resolve',
          entity: 'incident',
          entityId: saved.id,
          before: { status: current.status },
          after: { status: saved.status },
        });
      return saved;
    });
  }

  async list(actor: LogisticsActor, limit = 50): Promise<readonly IncidentProps[]> {
    this.requireCarrierOrOperator(actor);
    const safeLimit = Math.min(Math.max(limit, 1), 200);
    return isLogisticsStaff(actor.role)
      ? this.repository.listIncidents(safeLimit)
      : this.repository.listIncidentsForCarrier(actor.sub, safeLimit);
  }

  private requireCarrierOrOperator(actor: LogisticsActor): void {
    if (actor.role !== 'carrier' && !isLogisticsStaff(actor.role))
      throw new DomainError('Rol no autorizado.', 'invalid_role');
  }
}
