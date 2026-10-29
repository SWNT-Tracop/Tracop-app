# TRACOP

Monorepo de TRACOP, plataforma móvil de abastecimiento agropecuario. Esta fase contiene únicamente la base técnica: API, contratos compartidos, configuración, infraestructura local y documentación.

## Requisitos

- Node.js 22 (`.nvmrc`)
- pnpm 9.15.4 (`corepack enable`)
- Docker Compose

## Desarrollo

```bash
cp .env.example .env
# Set DATABASE_URL, POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB,
# MINIO_ROOT_USER and MINIO_ROOT_PASSWORD in .env before starting services.
pnpm install
docker compose up -d
pnpm db:migrate
pnpm dev
```

La API queda disponible en `http://localhost:3000/health`.
