import { DomainError } from '../../../shared/kernel/domain-error.js';
import type { CheckinKind } from './trip-states.js';

export interface TripStopProps {
  readonly id: string;
  readonly tripId: string;
  readonly orderId: string;
  readonly orderVersion: number;
  readonly kind: CheckinKind;
  readonly sequence: number;
  readonly zone: string;
  readonly scheduledAt: Date | null;
  readonly completedAt: Date | null;
}

export class TripStop {
  private constructor(readonly props: TripStopProps) {}

  static create(props: TripStopProps): TripStop {
    if (props.sequence < 1) throw new DomainError('Secuencia inválida.', 'invalid_stop');
    if (props.orderVersion < 1)
      throw new DomainError('Versión de pedido inválida.', 'invalid_stop');
    if (!props.zone.trim()) throw new DomainError('Zona de parada requerida.', 'invalid_stop');
    return new TripStop({ ...props });
  }

  static reconstitute(props: TripStopProps): TripStop {
    return new TripStop({ ...props });
  }

  complete(at: Date): void {
    if (this.props.completedAt)
      throw new DomainError('La parada ya fue completada.', 'invalid_transition');
    (this.props as { completedAt: Date | null }).completedAt = at;
  }
}
