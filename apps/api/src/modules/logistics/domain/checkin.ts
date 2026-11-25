import { DomainError } from '../../../shared/kernel/domain-error.js';
import type { CheckinKind } from './trip-states.js';

export interface CheckinProps {
  readonly id: string;
  readonly stopId: string;
  readonly tripId: string;
  readonly orderId: string;
  readonly carrierId: string;
  readonly kind: CheckinKind;
  readonly clientAt: Date;
  readonly serverAt: Date;
  readonly mediaRef: string | null;
}

const MAX_CLIENT_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

export class Checkin {
  private constructor(readonly props: CheckinProps) {}

  static create(input: CheckinProps & { readonly stopKind: CheckinKind }): Checkin {
    if (input.kind !== input.stopKind)
      throw new DomainError('El tipo de check-in no coincide con la parada.', 'invalid_checkin');
    if (Number.isNaN(input.clientAt.getTime()))
      throw new DomainError('Fecha del cliente inválida.', 'invalid_checkin');
    if (Math.abs(input.serverAt.getTime() - input.clientAt.getTime()) > MAX_CLIENT_CLOCK_SKEW_MS)
      throw new DomainError('La fecha del cliente está fuera de rango.', 'invalid_checkin');
    if (input.mediaRef !== null && (input.mediaRef.length < 1 || input.mediaRef.length > 512))
      throw new DomainError('Referencia de evidencia inválida.', 'invalid_checkin');
    return new Checkin({
      id: input.id,
      stopId: input.stopId,
      tripId: input.tripId,
      orderId: input.orderId,
      carrierId: input.carrierId,
      kind: input.kind,
      clientAt: input.clientAt,
      serverAt: input.serverAt,
      mediaRef: input.mediaRef,
    });
  }

  static reconstitute(props: CheckinProps): Checkin {
    return new Checkin({ ...props });
  }
}
