#!/usr/bin/env bash
# Despliegue de una versión en producción: copia previa, migración, arranque y verificación.
# Uso: SSH_HOST=<host> SSH_USER=<user> ./scripts/deploy/deploy.sh v0.1.0
set -euo pipefail

VERSION="${1:?uso: deploy.sh <version>}"
APP_DIR="${APP_DIR:-/opt/tracop/prod}"
PUBLIC_URL="${PUBLIC_URL:?uso: PUBLIC_URL=https://api.<dominio> deploy.sh <version>}"

ssh_run() { ssh "${SSH_USER}@${SSH_HOST}" "$1"; }

echo "1/4 Copia previa de la base"
ssh_run "cd ${APP_DIR} && docker compose exec -T backup sh /scripts/pg-backup.sh"

echo "2/4 Descargando imagen ${VERSION}"
ssh_run "cd ${APP_DIR} && VERSION=${VERSION} docker compose pull"

echo "3/4 Migrando y arrancando (migrate + api + worker)"
ssh_run "cd ${APP_DIR} && VERSION=${VERSION} docker compose up -d --wait api worker"

echo "4/4 Verificando /health y /ready"
ssh_run "curl -fsS ${PUBLIC_URL}/health && curl -fsS ${PUBLIC_URL}/ready"

echo "Despliegue de ${VERSION} completo."
