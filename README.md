# TRACOP

Monorepo de TRACOP, plataforma móvil de abastecimiento agropecuario. Esta fase contiene únicamente la base técnica: API, contratos compartidos, configuración, infraestructura local y documentación.

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

Para crear roles internos en desarrollo, ejecuta `pnpm identity:create-staff --phone +573001234567 --name "Nombre" --role operator`. El seed local sintético es `pnpm db:seed` y solo se permite con `NODE_ENV=development`.

## SonarCloud (pasos manuales)

El análisis de SonarCloud es opcional y vive en `.github/workflows/sonar.yml`. El workflow no falla si el secreto no existe: emite un aviso y omite el análisis. Para activarlo:

1. Crea una cuenta/organización en SonarCloud y el proyecto con la key configurada en `sonar-project.properties`.
2. En GitHub, ve a **Settings → Secrets and variables → Actions → New repository secret** y crea `SONAR_TOKEN` con el token del proyecto de SonarCloud.
3. En SonarCloud, abre el proyecto y desactiva **Automatic Analysis** (**Administration → Analysis Method**) para que el análisis lo ejecute solo el CI y no haya conflicto.
4. Verifica que `sonar.organization` y `sonar.projectKey` en `sonar-project.properties` correspondan a las keys reales.

Sin `SONAR_TOKEN`, el paso de análisis se omite con un `::warning::` y el job queda en verde.
