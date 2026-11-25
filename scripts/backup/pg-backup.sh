#!/bin/sh
# One logical backup of the database (pg_dump custom format, compressed) into $BACKUP_DIR,
# then keeps only the newest $BACKUP_KEEP files. Uses the libpq variables PGHOST, PGPORT,
# PGUSER, PGPASSWORD and PGDATABASE; prints only file names and sizes.
set -eu
BACKUP_DIR=${BACKUP_DIR:-/backups}
BACKUP_KEEP=${BACKUP_KEEP:-7}
mkdir -p "$BACKUP_DIR"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
target="$BACKUP_DIR/tracop-$stamp.dump"
pg_dump --format=custom --compress=6 --no-owner --file="$target.partial"
mv "$target.partial" "$target"
echo "backup written: $(basename "$target") ($(wc -c < "$target") bytes)"
# Retention: newest first, delete the rest.
ls -1t "$BACKUP_DIR"/tracop-*.dump 2>/dev/null | tail -n +"$((BACKUP_KEEP + 1))" | while read -r old; do
  rm -f "$old" && echo "backup removed: $(basename "$old")"
done
