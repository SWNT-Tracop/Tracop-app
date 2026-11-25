-- A reservation whose order has a payment proof under review is held: it keeps subtracting
-- stock and no longer lapses, so expires_at becomes NULL until the proof is verified
-- (status 'consumed') or rejected (a new, short expiry). The existing expiry check passes
-- for NULL. Consumed reservations keep subtracting stock: the lot quantity was sold.
ALTER TABLE catalog.lot_reservations ALTER COLUMN expires_at DROP NOT NULL;
