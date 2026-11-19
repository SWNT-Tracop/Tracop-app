ALTER TABLE ordering.order_events ADD COLUMN sequence integer;

WITH numbered AS (
  SELECT id, row_number() OVER (PARTITION BY order_id ORDER BY occurred_at, id)::integer AS sequence
  FROM ordering.order_events
)
UPDATE ordering.order_events AS events
SET sequence = numbered.sequence
FROM numbered
WHERE events.id = numbered.id;

ALTER TABLE ordering.order_events ALTER COLUMN sequence SET NOT NULL;
ALTER TABLE ordering.order_events ADD CONSTRAINT order_events_sequence_positive CHECK (sequence > 0);
ALTER TABLE ordering.order_events ADD CONSTRAINT order_events_order_sequence_unique UNIQUE (order_id, sequence);
