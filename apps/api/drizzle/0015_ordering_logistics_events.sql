ALTER TABLE ordering.order_events
  DROP CONSTRAINT order_events_type_check,
  ADD CONSTRAINT order_events_type_check
    CHECK (type IN (
      'OrderRequested',
      'OrderQuoted',
      'OrderAccepted',
      'OrderCancelled',
      'OrderPickupScheduled',
      'OrderInTransit',
      'OrderDelivered'
    ));
