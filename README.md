# TRACOP

Monorepo de TRACOP, plataforma móvil de abastecimiento agropecuario. Esta fase contiene la base técnica (API, contratos compartidos, configuración, infraestructura local y documentación) y el módulo de identidad con autenticación por teléfono + OTP.

## Requisitos

- Node.js 22 (`.nvmrc`)
- pnpm 9.15.4 (`corepack enable`)
- Docker Compose

## Desarrollo

```bash
cp .env.example .env
# Completa DATABASE_URL, PostgreSQL, JWT_SECRET, OTP_HMAC_SECRET y RATE_LIMIT_HMAC_SECRET.
pnpm install
docker compose up -d
pnpm db:migrate
pnpm dev
```

La API queda disponible en `http://localhost:3000/health`; OpenAPI está en `/docs`. En desarrollo, OTP se imprime en la terminal con el teléfono enmascarado. MinIO es opcional: completa `MINIO_ROOT_USER` y `MINIO_ROOT_PASSWORD` y ejecuta `docker compose --profile storage up -d minio` solo cuando pruebes almacenamiento de objetos.

## Autenticación (identity)

El módulo `identity` expone `/auth/register`, `/auth/otp/request`, `/auth/otp/verify`, `/auth/refresh`, `/auth/logout`, `GET /me` y `PATCH /me`. El detalle de capas, flujo y concurrencia está en [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#identity-y-autenticación), la decisión en [ADR-008](docs/adr/ADR-008.md) y la superficie del módulo en [apps/api/src/modules/identity/README.md](apps/api/src/modules/identity/README.md).

Variables JWT relevantes (ver `.env.example`):

| Variable                      | Requisito / valor por defecto   |
| ----------------------------- | ------------------------------- |
| `JWT_SECRET`                  | Obligatoria, mínimo 32 bytes    |
| `JWT_ISSUER`                  | Por defecto `tracop`            |
| `JWT_AUDIENCE`                | Por defecto `tracop-api`        |
| `JWT_CLOCK_TOLERANCE_SECONDS` | Por defecto `5`, máximo `60`    |
| `ACCESS_TOKEN_TTL_SECONDS`    | Por defecto `900` (15 minutos)  |
| `REFRESH_TOKEN_TTL_SECONDS`   | Por defecto `2592000` (30 días) |

Los roles internos (`operator`, `finance`, `admin`) se crean por CLI o seed, nunca por HTTP:

```bash
pnpm identity:create-staff --phone +573001234567 --name "Nombre" --role operator
# En producción exige --confirm; el comando se rechaza con NODE_ENV=test.
```

El seed local sintético es `pnpm db:seed` y solo se permite con `NODE_ENV=development`.

## Pruebas

```bash
pnpm test                       # todas las unidades y aplicaciones del monorepo
pnpm --filter @tracop/api test  # solo la API, con cobertura
```

Las pruebas de la API requieren Docker: Jest con `--coverage` levanta PostgreSQL 16 con Testcontainers. Las pruebas de identity son `apps/api/test/identity.e2e-spec.ts` (flujo, concurrencia y reuse detection), `identity-logging.e2e-spec.ts` (redacción de logs), `identity-application.spec.ts`, `identity-authorization.spec.ts` y `otp-sender.contract-spec.ts`. La cobertura se mide sobre dominio, aplicación, `app.module` y `shared/kernel`; umbrales: dominio 90 % de líneas, aplicación 80 %, global 75 %.

## SonarCloud (pasos manuales)

El análisis de SonarCloud es opcional y vive en `.github/workflows/sonar.yml`. El workflow no falla si el secreto no existe: emite un aviso y omite el análisis. Para activarlo:

1. Crea una cuenta/organización en SonarCloud y el proyecto con la key configurada en `sonar-project.properties`.
2. En GitHub, ve a **Settings → Secrets and variables → Actions → New repository secret** y crea `SONAR_TOKEN` con el token del proyecto de SonarCloud.
3. En SonarCloud, abre el proyecto y desactiva **Automatic Analysis** (**Administration → Analysis Method**) para que el análisis lo ejecute solo el CI y no haya conflicto.
4. Verifica que `sonar.organization` y `sonar.projectKey` en `sonar-project.properties` correspondan a las keys reales.

El workflow ejecuta `pnpm test` antes del escaneo para generar los reportes LCOV que consume Sonar. `sonar-project.properties` excluye adaptadores, puertos, wiring de módulos y `shared/infra` de la cobertura, y excluye `*.spec.ts`/`*.test.ts` de `sonar.sources`. Sin `SONAR_TOKEN`, el paso de análisis se omite con un `::warning::` y el job queda en verde.

## Documentación

- [Arquitectura](docs/ARCHITECTURE.md)
- [Glosario](docs/GLOSSARY.md)
- [ADR-008: autenticación por teléfono + OTP](docs/adr/ADR-008.md)
- [Aviso de privacidad (texto pendiente)](docs/PRIVACY_NOTICE.md)
