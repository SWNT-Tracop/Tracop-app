import { DomainError } from '../../../shared/kernel/domain-error.js';
import type { CheckinKind } from './trip-states.js';
import { TRIP_TRANSITIONS, type TripStatus } from './trip-states.js';
import type { LogisticsEvent } from './logistics-events.js';

export interface PlannedStopSnapshot {
  readonly stopId: string;
  readonly orderId: string;
  readonly kind: CheckinKind;
  readonly sequence: number;
  readonly zone: string;
}

export interface TripProps {
  readonly id: string;
  readonly carrierId: string;
  readonly status: TripStatus;
  readonly version: number;
  readonly plannedAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
  readonly route: readonly PlannedStopSnapshot[];
}

export class Trip {
  private readonly pendingEvents: LogisticsEvent[] = [];
  private constructor(readonly props: TripProps) {}

  static create(props: TripProps): Trip {
    if (props.version < 1) throw new DomainError('Versión inválida.', 'invalid_trip');
    if (props.route.length === 0)
      throw new DomainError('Un viaje debe tener al menos una parada.', 'empty_trip');
    if (props.status !== 'planned')
      throw new DomainError('Un viaje nuevo debe estar planeado.', 'invalid_transition');
    return new Trip({ ...props });
  }

  static reconstitute(props: TripProps): Trip {
    return new Trip({ ...props });
  }

  assign(carrierId: string, at: Date): void {
    if (carrierId !== this.props.carrierId)
      throw new DomainError(
        'El viaje ya está asignado a otro transportista.',
        'assignment_conflict',
      );
    if (this.props.status === 'assigned') return;
    this.transition('assigned', at);
    this.emit('TripAssigned', at, { carrierId });
  }

  reassign(carrierId: string, at: Date): void {
    if (this.props.status !== 'assigned' && this.props.status !== 'planned')
      throw new DomainError('El viaje ya está en camino.', 'invalid_transition');
    (this.props as { carrierId: string }).carrierId = carrierId;
    this.version += 1;
    (this.props as { updatedAt: Date }).updatedAt = at;
    this.emit('TripAssigned', at, { carrierId, reassigned: true });
  }

  start(at: Date): void {
    this.transition('in_progress', at);
    this.emit('TripStarted', at, { carrierId: this.props.carrierId });
  }

  complete(at: Date): void {
    this.transition('completed', at);
    this.emit('TripCompleted', at, {});
  }

  cancel(at: Date, reason: string): void {
    this.transition('cancelled', at);
    this.emit('TripCancelled', at, { reason });
  }

  drainEvents(): readonly LogisticsEvent[] {
    return this.pendingEvents.splice(0);
  }

  private get version(): number {
    return this.props.version;
  }

  private set version(value: number) {
    (this.props as { version: number }).version = value;
  }

  private transition(next: TripStatus, at: Date): void {
    if (!TRIP_TRANSITIONS[this.props.status].includes(next))
      throw new DomainError('Transición de viaje inválida.', 'invalid_transition');
    (this.props as { status: TripStatus }).status = next;
    this.version += 1;
    (this.props as { updatedAt: Date }).updatedAt = at;
  }

  private emit(type: LogisticsEvent['type'], at: Date, payload: Record<string, unknown>): void {
    this.pendingEvents.push({
      type,
      aggregateId: this.props.id,
      occurredAt: at.toISOString(),
      payload: { status: this.props.status, version: this.props.version, ...payload },
    });
  }
}
