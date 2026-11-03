ALTER TABLE catalog.lot_photos
  ADD COLUMN state text NOT NULL DEFAULT 'pending',
  ADD COLUMN content_type text,
  ADD COLUMN size_bytes integer,
  ADD COLUMN position integer NOT NULL DEFAULT 1,
  ADD COLUMN expires_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN lease_token text,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN deleted_at timestamptz;

WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY lot_id ORDER BY created_at, id)::integer AS position
  FROM catalog.lot_photos
)
UPDATE catalog.lot_photos AS photos
SET position = ranked.position,
    expires_at = now() - interval '2 hours'
FROM ranked
WHERE photos.id = ranked.id;

ALTER TABLE catalog.lot_photos
  ADD CONSTRAINT lot_photos_state_check CHECK (state IN ('pending', 'processing', 'ready')),
  ADD CONSTRAINT lot_photos_position_check CHECK (position > 0),
  ADD CONSTRAINT lot_photos_size_check CHECK (size_bytes IS NULL OR size_bytes > 0),
  ADD CONSTRAINT lot_photos_ready_metadata_check CHECK (
    (state = 'ready' AND content_type = 'image/webp' AND size_bytes IS NOT NULL)
    OR (state <> 'ready' AND content_type IS NULL AND size_bytes IS NULL)
  );

CREATE INDEX lot_photos_expiry_idx ON catalog.lot_photos(expires_at) WHERE state <> 'ready';
CREATE INDEX lot_photos_order_idx ON catalog.lot_photos(lot_id, position) WHERE deleted_at IS NULL;
-- No unique index on (lot_id, position): reordering swaps positions in one UPDATE and
-- ties are resolved deterministically by (position, id).
