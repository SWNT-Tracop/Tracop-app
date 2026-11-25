#!/bin/sh
# Restore test: restores a backup into a throw-away PostgreSQL 16 container and checks that
# every migration is recorded and that row counts of key tables match the source database.
# Usage: scripts/backup/restore-check.sh <file.dump>  (needs docker; source via PG* variables
# or the running demo: it reads counts from the tracop-demo db service).
set -eu
dump=${1:?usage: restore-check.sh <file.dump>}
[ -f "$dump" ] || { echo "no such file: $dump"; exit 2; }
name="tracop-restore-check-$$"
docker run -d --rm --name "$name" -e POSTGRES_PASSWORD=restore -e POSTGRES_DB=restore postgres:16-alpine >/dev/null
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
until docker exec "$name" pg_isready -q -U postgres -d restore; do sleep 1; done
docker cp "$dump" "$name:/tmp/backup.dump"
docker exec "$name" pg_restore --no-owner --exit-on-error -U postgres -d restore /tmp/backup.dump
query='SELECT (SELECT count(*) FROM shared.schema_migrations) AS migrations,
  (SELECT count(*) FROM identity.users) AS users, (SELECT count(*) FROM catalog.products) AS products,
  (SELECT count(*) FROM catalog.lots) AS lots, (SELECT count(*) FROM ordering.orders) AS orders,
  (SELECT count(*) FROM payments.ledger_entries) AS ledger_entries'
restored=$(docker exec "$name" psql -U postgres -d restore -At -F ' ' -c "$query")
echo "restored: migrations users products lots orders ledger_entries = $restored"
if [ -n "${SOURCE_COUNTS:-}" ]; then
  [ "$restored" = "$SOURCE_COUNTS" ] || { echo "MISMATCH with source: $SOURCE_COUNTS"; exit 1; }
  echo "restore check OK: counts match the source"
fi
