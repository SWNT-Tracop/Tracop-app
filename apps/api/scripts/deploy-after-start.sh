#!/bin/sh
# Runs inside the API image after a healthy start on the demo server (deploy and `compose up`).
# Both steps are idempotent: they only act when something is missing.
set -e
node dist/scripts/showcase-seed.js --skip-if-seeded
if [ -n "${BOOTSTRAP_ADMIN_PHONE:-}" ]; then
  node dist/scripts/create-staff.js --phone "$BOOTSTRAP_ADMIN_PHONE" --name "Administrador TRACOP" \
    --role admin --promote --if-needed
fi
