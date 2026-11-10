import { DomainError } from '../../../shared/kernel/domain-error.js';

export const ORDER_STATES = [
  'draft',
  'requested',
  'quoted',
  'accepted',
  'payment_pending',
  'paid',
  'pickup_scheduled',
  'in_transit',
  'delivered',
  'closed',
  'disputed',
  'cancelled',
] as const;
export type OrderStatus = (typeof ORDER_STATES)[number];

export interface OrderLineProps {
  readonly id: string;
  readonly lotId: string;
  readonly providerId: string;
  readonly quantityMilli: bigint;
  readonly unitPrice: bigint;
  readonly unit: string;
}

export interface OrderProps {
  readonly id: string;
  readonly buyerId: string;
  readonly providerId: string;
  readonly status: OrderStatus;
  readonly deliveryAddress: string;
  readonly deliveryWindow: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly version: number;
  readonly acceptedAt: Date | null;
  readonly cancelReason: string | null;
  readonly requestHash: string;
}

export type OrderEvent = {
  readonly type: 'OrderRequested' | 'OrderQuoted' | 'OrderAccepted' | 'OrderCancelled';
  readonly orderId: string;
  readonly occurredAt: string;
  readonly payload: Record<string, unknown>;
};

const transitions: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  draft: ['requested', 'cancelled'],
  requested: ['quoted', 'cancelled'],
  quoted: ['accepted', 'cancelled'],
  accepted: ['payment_pending', 'cancelled'],
  payment_pending: ['paid', 'cancelled'],
  paid: ['pickup_scheduled', 'disputed'],
  pickup_scheduled: ['in_transit', 'disputed'],
  in_transit: ['delivered', 'disputed'],
  delivered: ['closed', 'disputed'],
  disputed: ['closed'],
  closed: [],
  cancelled: [],
};

export class Order {
  private readonly pendingEvents: OrderEvent[] = [];
  private constructor(readonly props: OrderProps) {}

  static create(props: OrderProps): Order {
    if (!props.deliveryAddress.trim() || props.deliveryAddress.length > 500)
      throw new DomainError('La dirección de entrega no es válida.', 'invalid_delivery_address');
    if (props.version < 1) throw new DomainError('Versión inválida.', 'invalid_order');
    return new Order({ ...props });
  }

  static reconstitute(props: OrderProps): Order {
    return new Order({ ...props });
  }

  transition(next: OrderStatus, occurredAt: Date, details: Record<string, unknown> = {}): void {
    if (!transitions[this.props.status].includes(next))
      throw new DomainError('Transición de pedido inválida.', 'invalid_transition');
    (
      this.props as {
        status: OrderStatus;
        version: number;
        updatedAt: Date;
        acceptedAt: Date | null;
        cancelReason: string | null;
      }
    ).status = next;
    (this.props as { status: OrderStatus; version: number }).version += 1;
    (this.props as { status: OrderStatus; version: number; updatedAt: Date }).updatedAt =
      occurredAt;
    if (next === 'accepted') (this.props as { acceptedAt: Date | null }).acceptedAt = occurredAt;
    if (next === 'cancelled')
      (this.props as { cancelReason: string | null }).cancelReason =
        typeof details.reason === 'string' ? details.reason : 'buyer_cancelled';
    if (next === 'requested' || next === 'quoted' || next === 'accepted' || next === 'cancelled')
      this.pendingEvents.push({
        type:
          next === 'requested'
            ? 'OrderRequested'
            : next === 'quoted'
              ? 'OrderQuoted'
              : next === 'accepted'
                ? 'OrderAccepted'
                : 'OrderCancelled',
        orderId: this.props.id,
        occurredAt: occurredAt.toISOString(),
        payload: { status: next, ...details },
      });
  }

  drainEvents(): readonly OrderEvent[] {
    return this.pendingEvents.splice(0);
  }
}
