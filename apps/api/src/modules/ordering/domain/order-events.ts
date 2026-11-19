import { hashChain, verifyHashChain } from '../../../shared/kernel/hash-chain.js';
export { canonicalJson } from '../../../shared/kernel/hash-chain.js';

export interface OrderEventHashInput {
  readonly orderId: string;
  readonly sequence: number;
  readonly type: string;
  readonly actorId: string;
  readonly occurredAt: string | Date;
  readonly payload: Record<string, unknown>;
}

const stripHashFields = (value: unknown): unknown => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      ([key]) => key !== 'prevHash' && key !== 'hash',
    ),
  );
};

const isOrderEventHashInput = (event: unknown): event is OrderEventHashInput =>
  event !== null &&
  typeof event === 'object' &&
  !Array.isArray(event) &&
  'orderId' in event &&
  'sequence' in event &&
  'type' in event &&
  'actorId' in event &&
  'occurredAt' in event &&
  'payload' in event;

export const orderEventHashContent = (event: unknown): unknown => {
  if (!isOrderEventHashInput(event)) return stripHashFields(event);
  return {
    orderId: event.orderId,
    sequence: event.sequence,
    type: event.type,
    actorId: event.actorId,
    occurredAt:
      event.occurredAt instanceof Date ? event.occurredAt.toISOString() : event.occurredAt,
    payload: stripHashFields(event.payload),
  };
};

export const hashOrderEvent = (previousHash: string | null, event: unknown): string =>
  hashChain(previousHash, orderEventHashContent(event));

export const verifyOrderEventChain = (
  events: readonly {
    readonly prevHash: string | null;
    readonly hash: string;
    readonly payload: unknown;
  }[],
): boolean => {
  return verifyHashChain(events, (event) =>
    isOrderEventHashInput(event)
      ? orderEventHashContent(event)
      : orderEventHashContent(event.payload),
  );
};
