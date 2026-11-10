import { Order, type OrderProps } from './order.js';

const now = new Date('2026-11-10T12:00:00.000Z');
const props: OrderProps = {
  id: '018f47a2-8b45-7cc2-9a1e-123456789abc',
  buyerId: 'buyer',
  providerId: 'provider',
  status: 'requested',
  deliveryAddress: 'Dirección sintética',
  deliveryWindow: null,
  createdAt: now,
  updatedAt: now,
  version: 1,
  acceptedAt: null,
  cancelReason: null,
  requestHash: 'a'.repeat(64),
};

describe('Order state machine', () => {
  it('supports requested, quoted, accepted, payment_pending and cancellations', () => {
    const order = Order.create(props);
    order.transition('quoted', now);
    order.transition('accepted', now);
    order.transition('payment_pending', now);
    expect(order.props.status).toBe('payment_pending');
    expect(order.props.acceptedAt).toEqual(now);
    order.transition('cancelled', now, { reason: 'buyer_cancelled' });
    expect(order.props.cancelReason).toBe('buyer_cancelled');
    expect(order.drainEvents().map(({ type }) => type)).toEqual([
      'OrderQuoted',
      'OrderAccepted',
      'OrderCancelled',
    ]);
  });
  it.each(['requested', 'quoted', 'accepted', 'payment_pending'] as const)(
    'permits cancellation from %s',
    (status) => {
      expect(() =>
        Order.reconstitute({ ...props, status }).transition('cancelled', now),
      ).not.toThrow();
    },
  );
  it('rejects invalid transitions', () => {
    expect(() => Order.create(props).transition('paid', now)).toThrow('Transición');
  });
});
