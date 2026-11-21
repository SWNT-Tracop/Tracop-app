import { DomainError } from '../../../shared/kernel/domain-error.js';

export type IncidentStatus = 'open' | 'resolved';

export interface IncidentProps {
  readonly id: string;
  readonly orderId: string;
  readonly tripId: string | null;
  readonly type: string;
  readonly description: string;
  readonly status: IncidentStatus;
  readonly openedAt: Date;
  readonly closedAt: Date | null;
  readonly deletedAt: Date | null;
}

export class Incident {
  private constructor(readonly props: IncidentProps) {}

  static create(props: IncidentProps): Incident {
    if (props.status !== 'open')
      throw new DomainError('Una incidencia nueva debe estar abierta.', 'invalid_incident');
    if (!props.type.trim() || props.type.length > 60)
      throw new DomainError('Tipo de incidencia inválido.', 'invalid_incident');
    if (!props.description.trim() || props.description.length > 1000)
      throw new DomainError('Descripción de incidencia inválida.', 'invalid_incident');
    return new Incident({ ...props });
  }

  static reconstitute(props: IncidentProps): Incident {
    return new Incident({ ...props });
  }

  resolve(at: Date): void {
    if (this.props.status === 'resolved')
      throw new DomainError('La incidencia ya está resuelta.', 'invalid_transition');
    (this.props as { status: IncidentStatus }).status = 'resolved';
    (this.props as { closedAt: Date | null }).closedAt = at;
  }
}
