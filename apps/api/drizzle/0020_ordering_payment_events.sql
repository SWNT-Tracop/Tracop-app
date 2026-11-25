-- Payments moves orders through payment_pending, paid, disputed and closed; each transition
-- is recorded in the hash-chained order_events like the others.
ALTER TABLE ordering.order_events
  DROP CONSTRAINT order_events_type_check,
  ADD CONSTRAINT order_events_type_check
    CHECK (type IN (
      'OrderRequested',
      'OrderQuoted',
      'OrderAccepted',
      'OrderCancelled',
      'OrderPaymentPending',
      'OrderPaid',
      'OrderPickupScheduled',
      'OrderInTransit',
      'OrderDelivered',
      'OrderDisputed',
      'OrderClosed'
    ));
