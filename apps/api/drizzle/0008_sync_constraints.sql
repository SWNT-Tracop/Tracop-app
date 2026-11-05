ALTER TABLE sync.change_log
  ADD CONSTRAINT change_log_entity_length_check
    CHECK (char_length(entity) BETWEEN 1 AND 64),
  ADD CONSTRAINT change_log_entity_check
    CHECK (entity IN ('category', 'product', 'lot')),
  ADD CONSTRAINT change_log_op_length_check
    CHECK (char_length(op) BETWEEN 1 AND 32),
  ADD CONSTRAINT change_log_op_check
    CHECK (op IN ('upsert', 'delete', 'cancel')),
  ADD CONSTRAINT change_log_payload_size_check
    CHECK (octet_length(payload::text) <= 262144);

ALTER TABLE sync.processed_operations
  ADD CONSTRAINT processed_operations_entity_length_check
    CHECK (char_length(entity) BETWEEN 1 AND 64),
  ADD CONSTRAINT processed_operations_error_code_length_check
    CHECK (error_code IS NULL OR char_length(error_code) <= 100),
  ADD CONSTRAINT processed_operations_payload_hash_check
    CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT processed_operations_result_check
    CHECK (
      jsonb_typeof(result) = 'object'
      AND result->>'status' IN ('applied', 'rejected', 'conflict')
    );
