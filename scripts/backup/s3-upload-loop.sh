#!/bin/sh
# Uploads the dumps pg-backup.sh leaves in /backups to a private S3 bucket, then waits
# UPLOAD_INTERVAL_SECONDS. `aws s3 sync` skips the files that are already there, so running it
# every cycle only costs one HEAD per dump. Credentials come from the environment and belong to a
# user that can only write to that bucket (PutObject), never read or delete.
set -eu
: "${BACKUP_S3_URI:?BACKUP_S3_URI must be set, for example s3://tracop-backups-xxxx/staging}"
UPLOAD_INTERVAL_SECONDS=${UPLOAD_INTERVAL_SECONDS:-21600}
BACKUP_DIR=${BACKUP_DIR:-/backups}

while true; do
  if ls "$BACKUP_DIR"/tracop-*.dump >/dev/null 2>&1; then
    aws s3 sync "$BACKUP_DIR" "$BACKUP_S3_URI" \
      --exclude '*' --include 'tracop-*.dump' --only-show-errors \
      || echo "backup upload failed"
  fi
  sleep "$UPLOAD_INTERVAL_SECONDS"
done
