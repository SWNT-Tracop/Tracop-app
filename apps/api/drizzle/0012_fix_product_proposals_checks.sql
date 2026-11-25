-- Review consistency for product proposals.
-- Curated products (staff-created or created before proposals existed) are approved with no
-- proposer and need no reviewer. Proposals keep proposed_by for their whole life; once reviewed
-- (approved or rejected) they must record who reviewed them and when.

ALTER TABLE catalog.products
  DROP CONSTRAINT IF EXISTS products_proposal_review_check,
  ADD CONSTRAINT products_proposal_review_check
    CHECK (
      (status = 'pending_review'
        AND proposed_by IS NOT NULL AND reviewed_by IS NULL AND reviewed_at IS NULL) OR
      (status = 'approved' AND proposed_by IS NULL
        AND reviewed_by IS NULL AND reviewed_at IS NULL) OR
      (status IN ('approved', 'rejected') AND proposed_by IS NOT NULL
        AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
    );

-- The 0005 index on (category_id, lower(name)) ignores status and blocks re-proposing a
-- rejected product; products_category_search_text_active_unique (0011) replaces it.
DROP INDEX IF EXISTS catalog.products_category_name_unique;
