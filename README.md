# TRACOP

Monorepo de TRACOP, plataforma móvil de abastecimiento agropecuario. Esta fase contiene la base técnica (API, contratos compartidos, configuración, infraestructura local y documentación) y el módulo de identidad con autenticación por teléfono + OTP, y el módulo de mensajería con bot de Telegram (webhook y polling).

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

## Bot de Telegram (creación y configuración)

### 1. Crear el bot con @BotFather

1. Abre Telegram y busca **@BotFather**.
2. Envía `/newbot` y sigue las indicaciones:
   - **Nombre**: el que verán los usuarios (ej. "TRACOP Demo").
   - **Username**: debe terminar en `bot` (ej. `tracop_demo_bot`). Guárdalo: es `TELEGRAM_BOT_USERNAME`.
3. @BotFather te dará el **token** (ej. `123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ`). Guárdalo: es `TELEGRAM_BOT_TOKEN`.

### 2. Variables de entorno obligatorias

Edita `.env` y completa:

```env
TELEGRAM_MODE=webhook
TELEGRAM_BOT_TOKEN=123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ
TELEGRAM_WEBHOOK_SECRET=un_secreto_largo_aleatorio_para_validar_webhook
TELEGRAM_BOT_USERNAME=tracop_demo_bot
TELEGRAM_API_ROOT=https://api.telegram.org
TELEGRAM_WEBHOOK_PROCESS_TIMEOUT_MS=5000
TELEGRAM_RATE_LIMIT_PER_SENDER=20
TELEGRAM_RATE_LIMIT_GLOBAL=300
TELEGRAM_RATE_LIMIT_WINDOW_SECONDS=60
```

> `TELEGRAM_WEBHOOK_SECRET` debe ser un string aleatorio largo (mín. 32 caracteres). Se usa en la cabecera `x-telegram-bot-api-secret-token` para validar que el webhook viene de Telegram.

### 3. Probar con polling (desarrollo local sin túnel)

Para probar sin exponer un HTTPS público:

```env
TELEGRAM_MODE=polling
# TELEGRAM_WEBHOOK_SECRET no es necesario en polling
```

Ejecuta `pnpm dev`. El bot arranca en polling (`bot.on('message')`) y borra cualquier webhook previo. Escribe `/start` al bot en Telegram; deberías ver el botón "Compartir contacto".

> **Nota**: `TELEGRAM_MODE=polling` solo funciona con `NODE_ENV=development`. En producción **debe** ser `webhook`.

### 4. Registrar el webhook (producción / túnel local)

Con un HTTPS accesible desde internet (ej. ngrok, Cloudflare Tunnel, dominio propio):

```bash
# Ejemplo con ngrok
ngrok http 3000
# Copia la URL HTTPS (ej. https://abcd1234.ngrok-free.app)
```

Registra el webhook con el script incluido (usa las variables del `.env`):

```bash
pnpm telegram:set-webhook -- https://abcd1234.ngrok-free.app/webhooks/telegram
```

El script envía `allowed_updates: ['message']`, lo que coincide con lo que procesa el código actual (mensajes de chat privado). Si en el futuro se añade soporte para botones inline (`callback_query`), habrá que agregarlo tanto aquí como en el normalizador.

Verifica:

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo"
```

Debe mostrar `url` con tu endpoint, `has_custom_certificate: false`, `pending_update_count: 0` y `last_error_date: 0`.

Vuelve a `.env` y pon `TELEGRAM_MODE=webhook`. Reinicia `pnpm dev`.

### 5. Vincular tu cuenta (flujo completo)

1. Escribe `/start` al bot.
2. Toca el botón **"Compartir contacto"**.
3. El bot responde "¡Cuenta vinculada!" (o "Ya estaba vinculada").
4. Ahora `/auth/otp/request` con tu teléfono enviará el OTP por Telegram (si `OTP_SENDER=telegram`).

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

## Mensajería (messaging)

El módulo `messaging` recibe updates de Telegram (webhook o polling), normaliza a `InboundMessage`, aplica rate limiting e idempotencia, y delega a la aplicación.

**Tipos soportados**: texto, contacto (botón de compartir). Los tipos voz, foto y ubicación se normalizan correctamente a `InboundMessage` pero el bot responde «aún no disponible» hasta que se implemente el asistente de IA. La decisión está en [ADR-009](docs/adr/ADR-009.md) y la arquitectura en [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#messaging-telegram--whatsapp).

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
- [ADR-009: mensajería con Telegram](docs/adr/ADR-009.md)
- [Aviso de privacidad (texto pendiente)](docs/PRIVACY_NOTICE.md)
