#!/bin/sh
# Runs pg-backup.sh now and then every BACKUP_INTERVAL_SECONDS (the demo's scheduled backup).
set -eu
until pg_isready -q; do sleep 2; done
while true; do
  sh /scripts/pg-backup.sh || echo "backup failed"
  sleep "${BACKUP_INTERVAL_SECONDS:-86400}"
done
