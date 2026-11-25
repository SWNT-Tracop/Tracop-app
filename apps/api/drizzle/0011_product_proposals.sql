ALTER TABLE catalog.products
  ADD COLUMN status text NOT NULL DEFAULT 'approved',
  ADD COLUMN proposed_by uuid,
  ADD COLUMN reviewed_by uuid,
  ADD COLUMN reviewed_at timestamptz,
  ADD COLUMN rejection_reason text;

UPDATE catalog.products
SET status = 'approved'
WHERE status IS NULL OR status = '';

ALTER TABLE catalog.products
  ADD CONSTRAINT products_status_check
    CHECK (status IN ('approved', 'pending_review', 'rejected')),
  ADD CONSTRAINT products_rejection_reason_check
    CHECK ((status = 'rejected' AND rejection_reason IS NOT NULL) OR
           (status <> 'rejected')),
  ADD CONSTRAINT products_proposal_review_check
    CHECK ((status = 'approved' AND proposed_by IS NULL) OR
           (status <> 'approved'));

CREATE UNIQUE INDEX products_category_search_text_active_unique
  ON catalog.products (category_id, search_text)
  WHERE deleted_at IS NULL AND status IN ('approved', 'pending_review');

CREATE INDEX products_status_proposed_by_idx
  ON catalog.products (status, proposed_by)
  WHERE deleted_at IS NULL;
