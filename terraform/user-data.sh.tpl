#!/bin/bash
set -euxo pipefail
exec > /var/log/tracop-bootstrap.log 2>&1

export DEBIAN_FRONTEND=noninteractive

# Docker Engine + compose plugin (Ubuntu)
apt-get update -y
apt-get install -y ca-certificates curl git openssl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list
apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
systemctl enable --now docker

# Repositorio (se compila en la propia instancia; no hay ECR en el lab)
rm -rf /opt/tracop
git clone "${repo_url}" /opt/tracop
cd /opt/tracop
git checkout "${repo_branch}"

# .env.demo con secretos aleatorios (solo datos sintéticos; nunca producción)
if [ ! -f .env.demo ]; then
  secret() { openssl rand -hex "$${1:-32}"; }
  umask 077
  cat > .env.demo <<EOF
POSTGRES_USER=tracop_demo
POSTGRES_PASSWORD=$(secret 24)
POSTGRES_DB=tracop_demo
JWT_SECRET=$(secret 32)
OTP_HMAC_SECRET=$(secret 32)
RATE_LIMIT_HMAC_SECRET=$(secret 32)
METRICS_TOKEN=$(secret 32)
PRIVACY_POLICY_VERSION=v0-draft
EOF
fi

# Storage en AWS S3 (sin MinIO). Sin claves estáticas: la API usa el instance role.
export S3_BUCKET="${media_bucket}"
export S3_REGION="${region}"
export DEMO_BIND=0.0.0.0
export DEMO_API_PORT=${api_port}

# setup migra + siembra datos sintéticos; luego API + worker (--wait espera el healthcheck)
docker compose -f docker-compose.aws.yml --env-file .env.demo up -d --build --wait api worker
