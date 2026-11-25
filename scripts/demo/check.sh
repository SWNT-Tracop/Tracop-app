#!/usr/bin/env bash
# Checks a running demo: health and readiness, that only the API and the public S3 port are
# published, that Swagger is off, that every user is synthetic, and that a backup restores.
set -euo pipefail
cd "$(dirname "$0")/../.."
compose() { docker compose -f docker-compose.demo.yml --env-file .env.demo "$@"; }
api="http://${DEMO_BIND:-127.0.0.1}:${DEMO_API_PORT:-3100}"
fail() { echo "FAIL: $*"; exit 1; }

curl -fsS "$api/health" >/dev/null || fail "/health"
for _ in $(seq 1 60); do curl -fsS "$api/ready" >/dev/null 2>&1 && break; sleep 2; done
curl -fsS "$api/ready" | grep -q '"status":"ready"' || fail "/ready (database and worker heartbeat)"
echo "ok   /health and /ready"

# Published ports per service, from docker compose's JSON (one object per line).
published=$(compose ps --format json | python3 -c '
import json, sys
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    for item in (json.loads(line) if line.startswith("[") else [json.loads(line)]):
        ports = sorted({p["TargetPort"] for p in item.get("Publishers") or [] if p.get("PublishedPort")})
        print(item["Service"], ",".join(map(str, ports)) or "-")
')
echo "$published" | while read -r service ports; do
  case "$service:$ports" in
    api:3000|storage:9000|*:-) ;;
    *) fail "$service publishes $ports" ;;
  esac
done
echo "ok   only the API (3000) and the public S3 endpoint (9000) are published: $(echo "$published" | tr '\n' ' ')"

status=$(curl -s -o /dev/null -w '%{http_code}' "$api/docs")
[ "$status" = 404 ] || fail "/docs answers $status (Swagger must be off in the demo)"
echo "ok   Swagger is off"

real=$(compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c "SELECT count(*) FROM identity.users WHERE phone NOT LIKE '"'"'+5730000000%'"'"' AND phone NOT LIKE '"'"'expired:%'"'"'"')
[ "$real" = 0 ] || fail "$real users outside the synthetic phone range"
echo "ok   only synthetic users"

latest=$(ls -1t backups/tracop-*.dump 2>/dev/null | head -1 || true)
[ -n "$latest" ] || { compose exec -T backup sh /scripts/pg-backup.sh >/dev/null; latest=$(ls -1t backups/tracop-*.dump | head -1); }
counts=$(compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -F " " -c "SELECT (SELECT count(*) FROM shared.schema_migrations), (SELECT count(*) FROM identity.users), (SELECT count(*) FROM catalog.products), (SELECT count(*) FROM catalog.lots), (SELECT count(*) FROM ordering.orders), (SELECT count(*) FROM payments.ledger_entries)"')
# A fresh backup so the counts compare like with like.
compose exec -T backup sh /scripts/pg-backup.sh >/dev/null
latest=$(ls -1t backups/tracop-*.dump | head -1)
SOURCE_COUNTS="$counts" sh scripts/backup/restore-check.sh "$latest" | sed 's/^/ok   /'
echo "demo check passed"
