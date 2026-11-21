ALTER TABLE sync.change_log
  DROP CONSTRAINT change_log_entity_check,
  ADD CONSTRAINT change_log_entity_check
    CHECK (entity IN ('category', 'product', 'lot', 'trip', 'checkin', 'incident'));
