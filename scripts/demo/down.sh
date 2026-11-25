#!/usr/bin/env bash
# Stops the demo. Data volumes are kept; DEMO_WIPE=1 also deletes them (and .env.demo stays).
set -euo pipefail
cd "$(dirname "$0")/../.."
[ -f .env.demo ] || { echo "No .env.demo: the demo was never started."; exit 0; }
if [ "${DEMO_WIPE:-0}" = 1 ]; then
  docker compose -f docker-compose.demo.yml --env-file .env.demo down --volumes --remove-orphans
else
  docker compose -f docker-compose.demo.yml --env-file .env.demo down --remove-orphans
fi
