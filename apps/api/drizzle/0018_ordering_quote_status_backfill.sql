-- DrizzleOrderRepository.save used to persist the order but not its quote, so quotes kept
-- 'active' after the order moved on. Align existing rows with what the use cases write:
-- accept -> 'accepted', cancel -> 'cancelled', quote expiry (cancel_reason 'expired') -> 'expired'.
UPDATE ordering.quotes AS quote
SET status = CASE
      WHEN o.status = 'cancelled' AND o.cancel_reason = 'expired' THEN 'expired'
      WHEN o.status = 'cancelled' THEN 'cancelled'
      ELSE 'accepted'
    END,
    updated_at = o.updated_at
FROM ordering.orders AS o
WHERE quote.order_id = o.id
  AND quote.status = 'active'
  AND o.status NOT IN ('draft', 'requested', 'quoted');
