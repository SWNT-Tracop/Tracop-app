import { DomainError } from '../../../shared/kernel/domain-error.js';
import { isWithinColombia } from '../../../shared/kernel/geo.js';
import type { ProductUnit } from './product.js';

export const LOT_STATES = [
  'draft',
  'published',
  'reserved',
  'sold_out',
  'expired',
  'cancelled',
] as const;
export type LotStatus = (typeof LOT_STATES)[number];
export type LotEvent =
  | { readonly type: 'LotPublished'; readonly lotId: string; readonly occurredAt: string }
  | { readonly type: 'LotExpired'; readonly lotId: string; readonly occurredAt: string }
  | {
      readonly type: 'LotCancelled';
      readonly lotId: string;
      readonly previousStatus: LotStatus;
      readonly occurredAt: string;
    };

export interface LotProps {
  readonly id: string;
  readonly providerId: string;
  readonly productId: string;
  readonly quantity: number;
  readonly unit: ProductUnit;
  readonly unitPrice: bigint;
  readonly qualityGrade: string | null;
  readonly availableFrom: Date;
  readonly availableUntil: Date;
  readonly locationLat: number;
  readonly locationLng: number;
  readonly status: LotStatus;
  readonly version: number;
}

const transitions: Readonly<Record<LotStatus, readonly LotStatus[]>> = {
  draft: ['published', 'cancelled'],
  published: ['reserved', 'expired', 'cancelled'],
  reserved: ['sold_out', 'cancelled'],
  sold_out: [],
  expired: [],
  cancelled: [],
};

export class Lot {
  private constructor(readonly props: LotProps) {}
  private readonly pendingEvents: LotEvent[] = [];

  static reconstitute(props: LotProps): Lot {
    return new Lot({ ...props });
  }

  static create(props: LotProps, productUnit: ProductUnit, now: Date, maxHorizonDays: number): Lot {
    if (!(props.quantity > 0) || !Number.isFinite(props.quantity))
      throw new DomainError('La cantidad debe ser positiva.', 'invalid_quantity');
    if (props.unitPrice <= 0n)
      throw new DomainError('El precio debe ser un entero positivo en COP.', 'invalid_price');
    if (props.unit !== productUnit)
      throw new DomainError('La unidad debe coincidir con la del producto.', 'unit_mismatch');
    if (props.availableFrom > props.availableUntil)
      throw new DomainError('La ventana de disponibilidad es inválida.', 'invalid_availability');
    if (props.availableUntil.getTime() > now.getTime() + maxHorizonDays * 86_400_000)
      throw new DomainError(
        'La disponibilidad supera el horizonte permitido.',
        'availability_horizon',
      );
    if (!isWithinColombia(props.locationLat, props.locationLng))
      throw new DomainError(
        'Las coordenadas deben estar dentro de Colombia.',
        'invalid_coordinates',
      );
    if (props.qualityGrade !== null && props.qualityGrade.length > 100)
      throw new DomainError('La calidad supera 100 caracteres.', 'invalid_quality');
    return new Lot({ ...props, status: 'draft', version: 1 });
  }

  transition(next: LotStatus, occurredAt: Date): void {
    const previousStatus = this.props.status;
    if (!transitions[previousStatus].includes(next))
      throw new DomainError('Transición de lote inválida.', 'invalid_transition');
    (this.props as { status: LotStatus; version: number }).status = next;
    (this.props as { status: LotStatus; version: number }).version += 1;
    if (next === 'published')
      this.pendingEvents.push({
        type: 'LotPublished',
        lotId: this.props.id,
        occurredAt: occurredAt.toISOString(),
      });
    if (next === 'expired')
      this.pendingEvents.push({
        type: 'LotExpired',
        lotId: this.props.id,
        occurredAt: occurredAt.toISOString(),
      });
    if (next === 'cancelled')
      this.pendingEvents.push({
        type: 'LotCancelled',
        lotId: this.props.id,
        previousStatus,
        occurredAt: occurredAt.toISOString(),
      });
  }

  drainEvents(): readonly LotEvent[] {
    return this.pendingEvents.splice(0);
  }
  static isVisibleNow(lot: LotProps, now: Date): boolean {
    return lot.status === 'published' && lot.availableUntil.getTime() >= now.getTime();
  }
}
