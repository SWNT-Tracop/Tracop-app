-- Trust values become run-time parameters (AGENTS §23, PROVISIONAL defaults from the environment).
ALTER TABLE backoffice.parameters
  DROP CONSTRAINT parameters_key_check,
  ADD CONSTRAINT parameters_key_check CHECK (key IN (
    'order.commission_rate_bps', 'order.freight_cop', 'order.quote_ttl_hours',
    'order.reservation_ttl_hours', 'payment.claim_window_hours',
    'payment.rejection_grace_hours', 'catalog.product_proposal_pending_limit',
    'trust.rating_window_days', 'trust.min_ratings_visible', 'trust.comment_max_length',
    'trust.verification_cooldown_days'
  ));
