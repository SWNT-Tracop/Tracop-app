# TRACOP: guía de despliegue para el equipo encargado

> **Para quién:** el equipo que va a desplegar y operar el backend de TRACOP en staging y luego en producción.
>
> **Qué contiene:**
>
> - todo lo que hay que tener, configurar y verificar;
> - todas las variables de entorno, con qué es cada una y de dónde sale;
> - el procedimiento paso a paso en AWS;
> - cómo operar el sistema después del despliegue.
>
> **Qué no contiene:** ningún secreto. Donde hace falta un valor secreto se indica cómo generarlo o quién lo aporta.
>
> **Estado:** a 2026-11-25 nada de esto se ha desplegado ni contratado. Los precios son estimaciones con fuente en [DEPLOYMENT-PLAN.md](DEPLOYMENT-PLAN.md). Lo marcado **NO verificado** no se ha podido confirmar.

## Contenido

1. [Qué se despliega](#1-qué-se-despliega)
2. [Plataforma elegida y coste](#2-plataforma-elegida-y-coste)
3. [Cuentas y accesos que se necesitan](#3-cuentas-y-accesos-que-se-necesitan)
4. [Lo que debe estar listo antes del primer despliegue](#4-lo-que-debe-estar-listo-antes-del-primer-despliegue)
5. [Variables de entorno](#5-variables-de-entorno)
6. [Despliegue paso a paso en AWS](#6-despliegue-paso-a-paso-en-aws)
7. [Verificación tras desplegar](#7-verificación-tras-desplegar)
8. [Operación](#8-operación)
9. [Telegram](#9-telegram)
10. [IA (opcional)](#10-ia-opcional)
11. [Lo que se entrega al equipo del móvil](#11-lo-que-se-entrega-al-equipo-del-móvil)
12. [Decisiones pendientes que bloquean etapas](#12-decisiones-pendientes-que-bloquean-etapas)
13. [Riesgos conocidos y NO verificado](#13-riesgos-conocidos-y-no-verificado)
14. [Referencias en el repositorio](#14-referencias-en-el-repositorio)

---

## 1. Qué se despliega

TRACOP es un monolito modular de NestJS (Node 22) sobre PostgreSQL 16. Una sola imagen Docker contiene todo; cambia el comando según el proceso.

| Proceso            | Comando en la imagen                        | Qué hace                                                                                                           | Instancias                                               | Puerto                                  |
| ------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- | --------------------------------------- |
| **API**            | `node dist/main.js`                         | API REST, webhook de Telegram, `/health`, `/ready`, `/metrics`                                                     | **Exactamente 1** (los límites de tasa viven en memoria) | 3000, interno; nunca se publica directo |
| **Trabajador**     | `node dist/worker.js`                       | 14 trabajos periódicos (pg-boss), despachador del outbox, avisos y asistente de IA. Escribe un latido cada minuto. | 1 o más                                                  | —                                       |
| **Migraciones**    | `npx tsx drizzle/migrate.ts`, hoy (ver §4)  | Aplica las migraciones SQL pendientes, solo hacia adelante                                                         | Una vez antes de cada versión                            | —                                       |
| **PostgreSQL 16**  | imagen `postgres:16-alpine`                 | Base de datos, un schema por módulo; pg-boss en el schema `pgboss`                                                 | 1                                                        | 5432, **solo red interna**              |
| **Proxy TLS**      | Caddy, propuesto                            | HTTPS con Let's Encrypt, redirige 80 a 443, tiempos máximos                                                        | 1                                                        | **80 y 443, los únicos públicos**       |
| **Copias**         | `scripts/backup/backup-loop.sh` (ya existe) | `pg_dump` periódico                                                                                                | 1                                                        | —                                       |
| **Almacenamiento** | Amazon S3, externo                          | Fotos de lotes y comprobantes de pago; bucket privado                                                              | —                                                        | HTTPS                                   |
| **Telegram**       | externo                                     | Bot: OTP, avisos, asistente                                                                                        | —                                                        | El webhook entra por 443                |

```
Internet ──443──► Caddy ──► api:3000 ──┐
   ▲                                    ├──► db:5432 (privado)
   │ HTTPS (URL firmadas)               │
   └─────────── Amazon S3 ◄── api ──────┘
Telegram ──webhook 443──► Caddy ──► api
                         worker ──► db, S3, Telegram, (IA)
                         backup ──► db ──► S3 de copias
```

**Requisitos de la aplicación que condicionan la infraestructura:**

1. **POST prefirmado con política:**
   - Las fotos y comprobantes los sube el cliente directo al almacenamiento, con un POST prefirmado que limita tamaño y tipo.
   - Sirven **Amazon S3** y MinIO.
   - **Cloudflare R2 no sirve:** no admite POST prefirmado.
2. **Conexión directa o en modo sesión con PostgreSQL:**
   - El código usa `LISTEN` y advisory locks.
   - Un pooler en modo transacción (PgBouncer) los rompe.
3. **Trabajador siempre encendido:** si se detiene más de `READY_WORKER_MAX_AGE_SECONDS` (180 s), `GET /ready` responde **503**.
4. **Una sola instancia de la API**, hasta que los límites de tasa se lleven a PostgreSQL.
5. **Telegram exige HTTPS público** en el puerto 443, 80, 88 u 8443.

## 2. Plataforma elegida y coste

**Recomendada para el piloto:**

- **AWS Lightsail**, una instancia Ubuntu de 2 GB en `us-east-1` (Virginia), con Docker Compose.
- **Amazon S3** en la misma región.

| Concepto                           | Staging                                 | Con producción                                     |
| ---------------------------------- | --------------------------------------- | -------------------------------------------------- |
| Lightsail 2 GB (con IPv4)          | US$12/mes                               | +US$12 o US$24 (producción en su propia instancia) |
| Instantáneas automáticas           | ~US$1–3                                 | ~US$2–6 (NO verificado)                            |
| S3, archivos y copias              | < US$1                                  | ~US$1–2                                            |
| Dominio `.co`                      | ~US$15–36 el primer año (NO verificado) | —                                                  |
| UptimeRobot, GitHub Actions y GHCR | US$0                                    | US$0                                               |
| **Total**                          | **~US$13–16/mes**                       | **~US$27–45/mes**, sin IA ni SMS                   |

- **Topes de gasto:** AWS Budgets con aviso a US$25 en staging y US$50 con producción. Si hay IA, un tope mensual en el workspace del proveedor, US$10 al empezar.
- **Alternativas evaluadas:** Render + S3, la universidad, Hetzner, DigitalOcean y AWS con EC2 + RDS. Están en [DEPLOYMENT-PLAN.md](DEPLOYMENT-PLAN.md), §1.

## 3. Cuentas y accesos que se necesitan

| #   | Qué                                                                                         | Quién lo crea                            | Para qué                                                   | Notas de seguridad                                                                                               |
| --- | ------------------------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1   | **Cuenta de AWS**                                                                           | Dueño del proyecto                       | Lightsail, S3, IAM y Budgets                               | MFA en la cuenta raíz, sin claves de acceso en la raíz. Cada persona del equipo con su propio usuario IAM y MFA. |
| 2   | **Dominio** con acceso al DNS                                                               | Dueño del proyecto                       | `api-staging.<dominio>` y `api.<dominio>`                  | Si el DNS lo maneja otra persona, basta con que cree los registros `A` del §6.5.                                 |
| 3   | **Bot de Telegram de staging**                                                              | Dueño del proyecto, en BotFather         | OTP y avisos en staging                                    | Nunca se usa el mismo bot en dos entornos.                                                                       |
| 4   | **Bot de Telegram de producción**                                                           | Dueño del proyecto, en la fase de piloto | OTP y avisos reales                                        | El token solo va en el `.env` de producción.                                                                     |
| 5   | **Gestor de contraseñas compartido** (Bitwarden, 1Password o similar)                       | El equipo                                | Guardar todos los secretos del §5                          | **Los secretos nunca se pasan por chat, correo, tickets ni el repositorio.**                                     |
| 6   | **Acceso al repositorio de GitHub** y, si es privado, permiso de lectura de paquetes (GHCR) | Administración del repositorio           | Bajar la imagen `ghcr.io/swnt-tracop/tracop-api:<versión>` | Para descargar de GHCR desde el servidor, un token de solo lectura de paquetes.                                  |
| 7   | **UptimeRobot**, plan gratuito                                                              | El equipo                                | Monitores de `/health` y `/ready`                          | Los avisos van al canal del equipo.                                                                              |
| 8   | **Canal de alertas** (chat de Telegram del equipo o correo)                                 | El equipo                                | Recibir todas las alertas                                  |                                                                                                                  |
| 9   | **Cuenta de Anthropic con un workspace propio**, solo si se activa la IA                    | Dueño del proyecto                       | `LLM_API_KEY`                                              | Tope de gasto mensual en el workspace.                                                                           |
| 10  | **Clave SSH** del equipo de operación                                                       | Cada operador                            | Entrar al servidor                                         | Solo con clave; sin contraseña ni `root`. Se recomienda limitarla por IP.                                        |

## 4. Lo que debe estar listo antes del primer despliegue

Son cambios de código que hace el equipo de backend, cada uno en su propio PR con pruebas. **Sin ellos el despliegue funciona, pero no cumple las condiciones de producción:**

| #   | Cambio                                                                                                                                                  | Por qué                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 4.1 | Imagen sin dependencias de desarrollo (`pnpm deploy --prod`)                                                                                            | Hoy la imagen pesa **842 MB** e incluye herramientas de desarrollo.                           |
| 4.2 | Migraciones compiladas (`dist/drizzle/migrate.js`) en lugar de `npx tsx`                                                                                | `tsx` es una dependencia de desarrollo y desaparece con 4.1.                                  |
| 4.3 | `docker-compose.prod.yml` y `Caddyfile`, con los servicios `caddy`, `migrate`, `api`, `worker`, `db` y `backup`, y tiempos máximos en Caddy             | Hoy solo existe el compose de la demo (`docker-compose.demo.yml`), que no tiene TLS ni proxy. |
| 4.4 | Roles de base de datos separados (`tracop_owner` para migrar y `tracop_app` para la API y el trabajador) y una variable nueva, `MIGRATION_DATABASE_URL` | Mínimo privilegio: la API no debe poder hacer DDL (§5.6).                                     |
| 4.5 | `release.yml`: construye y publica la imagen en GHCR con cada etiqueta `v*`, y `scripts/deploy/deploy.sh <versión>`                                     | Despliegue y rollback repetibles.                                                             |
| 4.6 | Subida de cada copia de seguridad a un bucket S3 aparte                                                                                                 | Hoy las copias se quedan en el disco del mismo servidor.                                      |
| 4.7 | Rechazar `PRIVACY_POLICY_VERSION=v0-draft` en producción                                                                                                | Hoy producción arranca con la versión borrador del aviso legal.                               |

Mientras no estén:

- se puede montar **staging** con el `Dockerfile` actual y un compose adaptado del de la demo;
- **producción no se abre** sin 4.1 a 4.7.

## 5. Variables de entorno

### 5.1 Cómo funcionan

- **Un archivo `.env` por entorno** en el servidor: `/opt/tracop/<entorno>/.env`, con permisos `600` y fuera del repositorio. Cada valor se copia del gestor de contraseñas.
- **Validación al arrancar:** la aplicación valida **todas** las variables con zod (`apps/api/src/shared/infra/env.ts`). Si falta una o es inválida, **no arranca** y el error nombra la variable, nunca su valor.
- **Valores por defecto:** las variables que no se definen toman el suyo (§5.7). El equipo solo tiene que definir las de §5.2 a §5.5.
- **Entornos separados:** nunca se comparten valores entre staging y producción. Cada uno tiene sus propios secretos, bucket, bot y base de datos.
- **Generar un secreto aleatorio:** `openssl rand -base64 48 | tr -d '/+=' | cut -c1-48`. Da 48 caracteres alfanuméricos; también sirve para `TELEGRAM_WEBHOOK_SECRET`, que solo admite `A-Z a-z 0-9 _ -`.

### 5.2 Obligatorias en staging y en producción

| Variable                                        | Qué es                                                     | Valor o cómo obtenerlo                                                                                                                                 | ¿Secreto?                      |
| ----------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| `NODE_ENV`                                      | Modo de ejecución                                          | `production`                                                                                                                                           | No                             |
| `APP_PROFILE`                                   | Perfil de la aplicación                                    | `production`. Staging también usa `production`, para validar lo mismo que producción. **Nunca** `demo` fuera de la demo local.                         | No                             |
| `DATABASE_URL`                                  | Conexión de la API y del trabajador                        | `postgres://tracop_app:<contraseña>@db:5432/tracop`. Usa el rol con privilegios mínimos (§5.6) y **conexión directa**, sin pooler en modo transacción. | **Sí**: contiene la contraseña |
| `JWT_SECRET`                                    | Firma los tokens de sesión                                 | Aleatorio. Con 4.7 / #75, al menos 32 caracteres, 10 distintos y sin palabras como `example` o `not-for-real`.                                         | **Sí**                         |
| `OTP_HMAC_SECRET`                               | HMAC de los códigos OTP                                    | Aleatorio y **distinto** de los demás (la app rechaza secretos repetidos)                                                                              | **Sí**                         |
| `RATE_LIMIT_HMAC_SECRET`                        | HMAC de contadores, IP del audit log y teléfonos expirados | Aleatorio y distinto. **No rotarlo salvo filtración**: invalida los seudónimos.                                                                        | **Sí**                         |
| `OTP_SENDER`                                    | Canal del OTP                                              | `telegram`. Es el único válido en producción.                                                                                                          | No                             |
| `TELEGRAM_MODE`                                 | Cómo llegan los mensajes                                   | `webhook`. Es el único válido en producción.                                                                                                           | No                             |
| `TELEGRAM_BOT_TOKEN`                            | Token del bot                                              | De BotFather, uno por entorno (§9)                                                                                                                     | **Sí**                         |
| `TELEGRAM_WEBHOOK_SECRET`                       | Secreto que Telegram manda en cada webhook                 | Aleatorio, 32 a 256 caracteres de `A-Z a-z 0-9 _ -`                                                                                                    | **Sí**                         |
| `TELEGRAM_BOT_USERNAME`                         | Usuario del bot, sin `@`                                   | Por ejemplo `tracop_staging_bot`                                                                                                                       | No                             |
| `S3_ENDPOINT`                                   | Endpoint S3 que usa el servidor                            | `https://s3.us-east-1.amazonaws.com`. En producción se exige HTTPS.                                                                                    | No                             |
| `S3_BUCKET`                                     | Bucket de archivos del entorno                             | Por ejemplo `tracop-staging-<sufijo>`                                                                                                                  | No                             |
| `S3_REGION`                                     | Región del bucket                                          | `us-east-1`                                                                                                                                            | No                             |
| `S3_API_ACCESS_KEY` / `S3_API_SECRET_KEY`       | Credencial de la API: leer, escribir y borrar objetos      | Usuario IAM `tracop-<entorno>-api` (§6.3)                                                                                                              | **Sí**                         |
| `S3_POLICY_ACCESS_KEY` / `S3_POLICY_SECRET_KEY` | Credencial que firma las subidas del cliente               | Usuario IAM `tracop-<entorno>-post`, **distinto** del anterior (§6.3)                                                                                  | **Sí**                         |

### 5.3 Recomendadas: hay que definirlas explícitamente

| Variable                 | Valor recomendado                                                                                                                          | Por qué                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `TRUST_PROXY`            | `1`                                                                                                                                        | Hay un proxy, Caddy, delante de la API. Sin esto, el límite por IP y el HMAC de IP verían la IP del proxy. |
| `METRICS_TOKEN`          | Aleatorio de 32 caracteres o más. **Secreto.**                                                                                             | Sin él, `GET /metrics` responde 404 y no hay métricas.                                                     |
| `PRIVACY_POLICY_VERSION` | La versión aprobada del aviso de privacidad, por ejemplo `2026-12-v1`                                                                      | El valor por defecto `v0-draft` es un borrador. Lo decide el equipo legal (§12).                           |
| `CORS_ALLOWED_ORIGINS`   | Vacío si solo hay app nativa. Con cliente web, los orígenes HTTPS exactos separados por comas, por ejemplo `https://backoffice.<dominio>`. | Sin comodines y sin rutas (lo valida `env.ts`).                                                            |
| `S3_PUBLIC_ENDPOINT`     | El mismo que `S3_ENDPOINT` con S3 real; puede omitirse                                                                                     | Solo es distinto cuando el cliente ve S3 por otra URL, como en la demo con MinIO.                          |
| `PORT`                   | `3000`                                                                                                                                     | Puerto interno al que apunta Caddy.                                                                        |
| `ALLOWED_COUNTRY_CODES`  | `57`                                                                                                                                       | Prefijos de teléfono admitidos en el registro: Colombia.                                                   |

### 5.4 Solo si se activa la IA (`AI_ENABLED=true`)

**Por defecto `AI_ENABLED=false`, y así se despliega.** Si se activa, la aplicación exige las cuatro primeras variables y no arranca sin ellas:

| Variable                                                | Valor                                                                                | ¿Secreto? |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------ | --------- |
| `LLM_PROVIDER`                                          | `anthropic` (el único admitido)                                                      | No        |
| `LLM_MODEL`                                             | El modelo que elija el equipo tras `pnpm ai:eval-live`. No tiene valor por defecto.  | No        |
| `LLM_API_KEY`                                           | Clave del workspace del entorno                                                      | **Sí**    |
| `AI_CONSENT_VERSION`                                    | Versión aprobada del aviso de IA. Sin valor por defecto.                             | No        |
| `LLM_BASE_URL`                                          | Vacío; solo se usa para un proxy propio                                              | No        |
| `AI_MONTHLY_TOKEN_CAP`                                  | `2000000` por defecto. Tope interno de tokens al mes, además del tope del proveedor. | No        |
| `AI_DAILY_REQUESTS_PER_USER` / `AI_REQUESTS_PER_MINUTE` | `30` / `6` por defecto                                                               | No        |

### 5.5 Parámetros de negocio PROVISIONALES: los decide producto

Tienen un valor por defecto, pero **ese valor no es una decisión de negocio**. Antes del piloto, el responsable de producto debe confirmarlos. Los marcados con † también los puede cambiar un `admin` desde el backoffice (`PUT /backoffice/parameters/{key}`); la variable de entorno es solo el valor inicial.

| Variable                                                                                                                           | Por defecto             | Qué decide                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------ |
| `ORDER_COMMISSION_RATE_BPS` †                                                                                                      | `0`                     | Comisión en puntos básicos: 500 = 5 %                        |
| `ORDER_FREIGHT_COP` †                                                                                                              | `0`                     | Flete fijo por pedido, en COP enteros                        |
| `ORDER_QUOTE_TTL_HOURS` † / `ORDER_RESERVATION_TTL_HOURS` †                                                                        | `24` / `24`             | Vigencia de la cotización y de la reserva sin pago           |
| `PAYMENT_CLAIM_WINDOW_HOURS` †                                                                                                     | `48`                    | Ventana de reclamo antes de liquidar                         |
| `PAYMENT_REJECTION_GRACE_HOURS` †                                                                                                  | `4`                     | Margen tras rechazar un comprobante                          |
| `CATALOG_PRODUCT_PROPOSAL_PENDING_LIMIT` †                                                                                         | `5`                     | Propuestas de producto pendientes por usuario                |
| `TRUST_RATING_WINDOW_DAYS` † / `TRUST_MIN_RATINGS_VISIBLE` † / `TRUST_COMMENT_MAX_LENGTH` † / `TRUST_VERIFICATION_COOLDOWN_DAYS` † | `7` / `3` / `500` / `7` | Reglas de las calificaciones y de la verificación            |
| `UNVERIFIED_RETENTION_HOURS`                                                                                                       | `24`                    | Cuándo expira un registro sin verificar                      |
| `OTP_RETENTION_DAYS` / `SESSION_RETENTION_DAYS` / `PROCESSED_UPDATES_RETENTION_DAYS`                                               | `7` / `30` / `7`        | Retención de datos personales (Ley 1581)                     |
| `LOGISTICS_LOCATION_MAX_TTL_HOURS`                                                                                                 | `24`                    | Cuánto tiempo puede ver el transportista la ubicación exacta |
| `CATALOG_LOT_MAX_HORIZON_DAYS`                                                                                                     | `90`                    | Máximo de días de disponibilidad de un lote                  |
| `RECOMMENDATIONS_*`                                                                                                                | ver §5.7                | Pesos y mínimos de las recomendaciones                       |

### 5.6 Variables y valores de infraestructura que no son de la aplicación

Las usa `docker-compose.prod.yml` (§4.3) o los scripts de operación, no la API.

| Variable                                              | Dónde                                           | Qué es                                                                                                     | ¿Secreto?             |
| ----------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------- |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | Servicio `db`                                   | Superusuario inicial del contenedor de PostgreSQL. Solo para crear los roles; la aplicación **no** lo usa. | La contraseña, **sí** |
| `MIGRATION_DATABASE_URL`                              | Servicio `migrate`; **nueva**, en el cambio 4.4 | Conexión con `tracop_owner`, el rol que hace DDL                                                           | **Sí**                |
| `BACKUP_INTERVAL_SECONDS` / `BACKUP_KEEP`             | Servicio `backup`                               | `21600` (cada 6 h) y `7` copias locales                                                                    | No                    |
| `PGHOST` / `PGUSER` / `PGPASSWORD` / `PGDATABASE`     | Servicio `backup`                               | Conexión para `pg_dump`. Basta un rol de solo lectura.                                                     | La contraseña, **sí** |
| Clave de acceso del bucket de copias                  | Script de subida a S3 (cambio 4.6)              | Usuario IAM `tracop-backups`, que solo escribe en el bucket de copias                                      | **Sí**                |
| `SYNC_TABLE_ALERT_BYTES`                              | Tarea de alerta (§8.3)                          | Umbral de tamaño de las tablas de sync: `1073741824` (1 GiB, PROVISIONAL)                                  | No                    |
| Token de lectura de GHCR                              | `docker login ghcr.io` en el servidor           | Solo si el repositorio o el paquete es privado                                                             | **Sí**                |

**Roles de PostgreSQL** (los crea el cambio 4.4):

| Rol             | Lo usa               | Privilegios                                                                                                                                                                                                  |
| --------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tracop_owner`  | Solo las migraciones | Dueño de los schemas de los módulos. DDL sin `SUPERUSER`.                                                                                                                                                    |
| `tracop_app`    | API y trabajador     | `USAGE` en los schemas; `SELECT`, `INSERT`, `UPDATE` y `DELETE` en las tablas; `USAGE` en las secuencias. Es dueño **solo** del schema `pgboss`, porque pg-boss crea y migra sus propias tablas al arrancar. |
| `tracop_backup` | Copias               | Solo lectura (`pg_read_all_data`)                                                                                                                                                                            |

**Conexiones esperadas:** unas 30 (la API abre un pool de 10, el trabajador otro de 10 y pg-boss el suyo, unas 10). El `max_connections` de 100 por defecto alcanza.

### 5.7 Resto de variables: valor por defecto correcto, no hace falta definirlas

Solo se cambian por una razón operativa concreta. Entre paréntesis, el valor por defecto.

- **Sesiones y OTP:**
  - Tokens: `JWT_ISSUER` (`tracop`), `JWT_AUDIENCE` (`tracop-api`), `JWT_CLOCK_TOLERANCE_SECONDS` (5), `ACCESS_TOKEN_TTL_SECONDS` (900), `REFRESH_TOKEN_TTL_SECONDS` (2 592 000, 30 días), `REFRESH_GRACE_SECONDS` (30).
  - Códigos: `OTP_LENGTH` (6), `OTP_TTL_SECONDS` (300), `OTP_MAX_ATTEMPTS` (5).
  - Límites por teléfono: `OTP_PHONE_LIMIT` (3), `OTP_PHONE_WINDOW_SECONDS` (600), `OTP_PHONE_COOLDOWN_LIMIT` (1), `OTP_PHONE_COOLDOWN_SECONDS` (60).
  - Límites por IP: `OTP_IP_REQUEST_LIMIT` (30), `OTP_IP_VERIFY_LIMIT` (60), `OTP_IP_WINDOW_SECONDS` (600).
  - Otros: `SUPPORTED_LOCALES` (`es-CO,en`), `RATE_LIMIT_RETENTION_SECONDS` (86 400).
- **Telegram:** `TELEGRAM_API_ROOT` (`https://api.telegram.org`), `TELEGRAM_WEBHOOK_PROCESS_TIMEOUT_MS` (5000), `TELEGRAM_RATE_LIMIT_PER_SENDER` (20), `TELEGRAM_RATE_LIMIT_GLOBAL` (300), `TELEGRAM_RATE_LIMIT_WINDOW_SECONDS` (60).
- **Catálogo y fotos:**
  - Búsqueda y propuestas: `CATALOG_SEARCH_RADIUS_MAX_KM` (500), `CATALOG_SEARCH_RATE_LIMIT` (60), `CATALOG_SEARCH_RATE_WINDOW_SECONDS` (60), `CATALOG_PRODUCT_PROPOSAL_RATE_LIMIT` (10), `CATALOG_PRODUCT_PROPOSAL_RATE_WINDOW_SECONDS` (60).
  - Límites de las fotos: `CATALOG_PHOTO_MAX_COUNT` (5), `CATALOG_PHOTO_MAX_BYTES` (5 MiB), `CATALOG_PHOTO_MAX_INPUT_PIXELS` (25 000 000), `CATALOG_PHOTO_MAX_INPUT_DIMENSION` (10 000), `CATALOG_PHOTO_MAX_OUTPUT_DIMENSION` (2048).
  - Vigencias: `CATALOG_PHOTO_PENDING_TTL_SECONDS` (1800), `CATALOG_PHOTO_UPLOAD_URL_TTL_SECONDS` (900), `CATALOG_PHOTO_DOWNLOAD_URL_TTL_SECONDS` (300), `CATALOG_PHOTO_PURGE_GRACE_SECONDS` (3600).
  - Procesamiento: `CATALOG_PHOTO_WEBP_QUALITY` (80), `CATALOG_PHOTO_CONCURRENCY` (2), `CATALOG_PHOTO_PROCESSING_LEASE_SECONDS` (300), `CATALOG_PHOTO_UPLOAD_RATE_LIMIT` (30), `CATALOG_PHOTO_UPLOAD_RATE_WINDOW_SECONDS` (60).
- **Sync:** `SYNC_PUSH_MAX_BODY_BYTES` (256 KiB), `SYNC_PUSH_RATE_LIMIT` (30), `SYNC_PULL_RATE_LIMIT` (120), `SYNC_RATE_WINDOW_SECONDS` (60).
- **Pedidos y pagos:**
  - Pedidos: `ORDER_SUBTOTAL_ROUNDING` (`half_up`), `ORDER_RATE_LIMIT` (60), `ORDER_RATE_WINDOW_SECONDS` (60), `ORDER_LOCK_TIMEOUT_MS` (2000), `ORDER_STATEMENT_TIMEOUT_MS` (10 000).
  - Comprobantes: `PAYMENT_PROOF_MAX_BYTES` (5 MiB), `PAYMENT_PROOF_UPLOAD_URL_TTL_SECONDS` (900), `PAYMENT_PROOF_DOWNLOAD_URL_TTL_SECONDS` (300).
- **Confianza y logística:** `TRUST_RATING_RATE_LIMIT` (20), `TRUST_VERIFICATION_RATE_LIMIT` (5), `TRUST_RATE_WINDOW_SECONDS` (3600), `LOGISTICS_LOCATION_RATE_LIMIT` (30), `LOGISTICS_LOCATION_RATE_WINDOW_SECONDS` (60).
- **Trabajador:**
  - Horarios en formato cron: `JOB_EXPIRE_LOTS_CRON` (`*/5 * * * *`), `JOB_EXPIRE_ORDERS_CRON` (`*/5 * * * *`), `JOB_PURGE_PHOTOS_CRON` (`17 * * * *`), `JOB_RETENTION_CRON` (`40 4 * * *`), `JOB_OUTBOX_DISPATCH_CRON` (`* * * * *`), `JOB_ISSUE_SETTLEMENTS_CRON` (`*/15 * * * *`), `JOB_SEND_NOTIFICATIONS_CRON` (`* * * * *`), `JOB_EXPIRE_UNVERIFIED_CRON` (`23 * * * *`), `JOB_WORKER_HEARTBEAT_CRON` (`* * * * *`), `JOB_AI_INBOX_CRON` (`* * * * *`), `JOB_AI_MAINTENANCE_CRON` (`*/10 * * * *`).
  - Disponibilidad: `READY_WORKER_MAX_AGE_SECONDS` (180).
  - Outbox: `OUTBOX_LEASE_SECONDS` (60), `OUTBOX_MAX_ATTEMPTS` (5), `OUTBOX_RETRY_BASE_SECONDS` (5), `OUTBOX_RETRY_MAX_SECONDS` (300).
  - Avisos: `NOTIFICATIONS_MAX_ATTEMPTS` (5), `NOTIFICATIONS_RETRY_BASE_SECONDS` (30), `NOTIFICATIONS_RETRY_MAX_SECONDS` (3600), `NOTIFICATIONS_LEASE_SECONDS` (60).
- **Recomendaciones, PROVISIONALES:**
  - Datos de referencia: `RECOMMENDATIONS_REFERENCE_MAX_AGE_DAYS` (30), `RECOMMENDATIONS_OBSERVATION_WINDOW_DAYS` (90).
  - Mínimos: `RECOMMENDATIONS_MIN_SAMPLE` (3), `RECOMMENDATIONS_MIN_OWN_OBSERVATIONS` (3), `RECOMMENDATIONS_MIN_OWN_PROVIDERS` (2).
  - Pesos: `RECOMMENDATIONS_WEIGHT_REORDER` (30), `RECOMMENDATIONS_WEIGHT_NEARBY` (20), `RECOMMENDATIONS_WEIGHT_GOOD_PRICE` (25), `RECOMMENDATIONS_WEIGHT_VERIFIED_PROVIDER` (15), `RECOMMENDATIONS_WEIGHT_FRESH` (10).
  - Alcance: `RECOMMENDATIONS_NEARBY_KM` (50), `RECOMMENDATIONS_FRESH_HOURS` (48), `RECOMMENDATIONS_CANDIDATE_LIMIT` (200), `RECOMMENDATIONS_DEFAULT_RADIUS_KM` (100).
  - Alertas y límites: `RECOMMENDATIONS_ALERTS_PER_USER` (10), `RECOMMENDATIONS_RATE_LIMIT` (60), `RECOMMENDATIONS_RATE_WINDOW_SECONDS` (60).
- **IA:** `LLM_TIMEOUT_MS` (15 000), `LLM_MAX_OUTPUT_TOKENS` (400), `AI_DRAFT_TTL_MINUTES` (30), `AI_FINISHED_DRAFT_RETENTION_DAYS` (7), `AI_USAGE_RETENTION_DAYS` (90), `AI_INBOX_LEASE_SECONDS` (60), `AI_INBOX_MAX_ATTEMPTS` (3).
- **Solo para la demo; no usar en staging ni en producción:** `OTP_DEMO_CAPTURE_FILE`, y los valores `OTP_SENDER=console` y `OTP_SENDER=demo_capture`.
- **Futuras, el código aún no las usa:** `WHATSAPP_*`, `FCM_CREDENTIALS`, `SMS_API_KEY`, `MAPS_API_KEY`.

La criticidad de cada variable está en [ENV-CRITICALITY.md](ENV-CRITICALITY.md). Una prueba (`apps/api/test/env-criticality.spec.ts`) garantiza que la lista está completa.

### 5.8 Plantilla del `.env` de un entorno

Sin valores secretos: `<…>` se reemplaza con lo que hay en el gestor de contraseñas.

```dotenv
# Perfil
NODE_ENV=production
APP_PROFILE=production
PORT=3000
TRUST_PROXY=1

# Base de datos (rol con privilegios mínimos, conexión directa)
DATABASE_URL=postgres://tracop_app:<contraseña-app>@db:5432/tracop
MIGRATION_DATABASE_URL=postgres://tracop_owner:<contraseña-owner>@db:5432/tracop   # tras el cambio 4.4
POSTGRES_USER=postgres
POSTGRES_PASSWORD=<contraseña-superusuario>
POSTGRES_DB=tracop

# Identidad: tres secretos aleatorios distintos, de 32 caracteres o más
JWT_SECRET=<aleatorio-1>
OTP_HMAC_SECRET=<aleatorio-2>
RATE_LIMIT_HMAC_SECRET=<aleatorio-3>
PRIVACY_POLICY_VERSION=<versión-aprobada>
ALLOWED_COUNTRY_CODES=57
OTP_SENDER=telegram

# Telegram: un bot por entorno
TELEGRAM_MODE=webhook
TELEGRAM_BOT_TOKEN=<token-de-botfather>
TELEGRAM_WEBHOOK_SECRET=<aleatorio-4>
TELEGRAM_BOT_USERNAME=<usuario_del_bot>

# Almacenamiento: Amazon S3, un bucket y dos usuarios IAM por entorno
S3_ENDPOINT=https://s3.us-east-1.amazonaws.com
S3_BUCKET=tracop-<entorno>-<sufijo>
S3_REGION=us-east-1
S3_API_ACCESS_KEY=<id-de-clave-api>
S3_API_SECRET_KEY=<secreto-de-clave-api>
S3_POLICY_ACCESS_KEY=<id-de-clave-post>
S3_POLICY_SECRET_KEY=<secreto-de-clave-post>

# Operación
METRICS_TOKEN=<aleatorio-5>
CORS_ALLOWED_ORIGINS=
BACKUP_INTERVAL_SECONDS=21600
BACKUP_KEEP=7

# IA (apagada hasta tener los textos legales)
AI_ENABLED=false

# Negocio: valores PROVISIONALES que debe confirmar producto (§5.5)
ORDER_COMMISSION_RATE_BPS=0
ORDER_FREIGHT_COP=0
```

### 5.9 Lo que el arranque comprueba en producción

Esto queda probado en `production-startup.spec.ts` y `environment.spec.ts`. La aplicación **se niega a arrancar** si:

- falta cualquiera de las variables obligatorias del §5.2;
- `OTP_SENDER` no es `telegram`, o `TELEGRAM_MODE` no es `webhook`;
- `S3_ENDPOINT` o `S3_PUBLIC_ENDPOINT` no usan HTTPS;
- `JWT_SECRET`, `OTP_HMAC_SECRET`, `RATE_LIMIT_HMAC_SECRET`, `TELEGRAM_WEBHOOK_SECRET` o `METRICS_TOKEN`:
  - tienen menos de 32 caracteres;
  - tienen menos de 10 caracteres distintos;
  - contienen marcas de ejemplo (`not-for-real`, `change-me`, `example`, `placeholder`, `dummy`, `replace`, `secret-here`);
  - o se repiten entre sí;
- `APP_PROFILE=production` sin `NODE_ENV=production`, o `APP_PROFILE=demo` con `NODE_ENV=production`;
- `CORS_ALLOWED_ORIGINS` tiene un comodín, un origen que no es HTTPS o una ruta;
- `AI_ENABLED=true` sin `LLM_PROVIDER`, `LLM_MODEL`, `LLM_API_KEY` y `AI_CONSENT_VERSION`.

## 6. Despliegue paso a paso en AWS

Todo se hace en la región **us-east-1 (N. Virginia)**. Los nombres entre `<>` son marcadores.

### 6.1 Cuenta (dueño del proyecto)

1. Crear la cuenta de AWS y activar **MFA en la cuenta raíz**. No crear claves de acceso para la raíz.
2. IAM: crear un usuario por persona del equipo de operación, con MFA, y usar siempre ese usuario.
3. **Billing → Budgets:** crear un presupuesto mensual de US$25, con avisos al 50 %, 80 % y 100 % al canal del equipo.
4. _Comprobación:_ cada persona entra con su usuario y su MFA, y el presupuesto aparece en Budgets.

### 6.2 Dominio (dueño del proyecto)

1. Comprar el dominio, o usar un subdominio de la universidad si TI lo concede.
2. El registro `A` se crea en el §6.5, cuando ya exista la IP estática.

### 6.3 Buckets S3 y usuarios IAM

1. **S3 → Create bucket** `tracop-staging-<sufijo>`:
   - región `us-east-1`;
   - **Block all public access** activado;
   - cifrado por defecto SSE-S3;
   - versionado desactivado.
2. **S3 → Create bucket** `tracop-backups-<sufijo>`:
   - con la misma configuración;
   - y una regla de ciclo de vida **«expire current versions after 30 days»** (PROVISIONAL).
3. **IAM → Policies:** crear tres políticas JSON, cada una solo sobre su bucket:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
         "Resource": "arn:aws:s3:::tracop-staging-<sufijo>/*"
       }
     ]
   }
   ```

   Esa es `tracop-staging-api`. Las otras dos:
   - `tracop-staging-post`: solo `s3:PutObject` sobre `arn:aws:s3:::tracop-staging-<sufijo>/incoming/*` y `…/payment-incoming/*`;
   - `tracop-backups-writer`: solo `s3:PutObject` sobre `arn:aws:s3:::tracop-backups-<sufijo>/*`.

4. **IAM → Users:** crear `tracop-staging-api`, `tracop-staging-post` y `tracop-backups`.
   - Ninguno tiene acceso a la consola; cada uno lleva su política.
   - Crear una **access key** para cada uno y guardarla **directamente** en el gestor de contraseñas.
5. _Comprobación:_ con la clave `post`, `aws s3 ls s3://tracop-staging-<sufijo>` debe dar **AccessDenied**, porque no puede listar.

### 6.4 Instancia Lightsail

1. **Lightsail → Create instance:**
   - `us-east-1`; Linux, **Ubuntu 24.04 LTS** o la LTS vigente;
   - plan de **2 GB**;
   - nombre `tracop-staging`;
   - **instantáneas automáticas** activadas.
2. **Networking:**
   - crear una **IP estática** y asociarla;
   - en el firewall IPv4, dejar **solo** HTTP 80, HTTPS 443 y SSH 22, restringido a las IP del equipo.
3. Entrar por SSH y preparar el sistema:

   ```bash
   sudo apt update && sudo apt -y upgrade && sudo apt -y install unattended-upgrades
   # Docker Engine y el plugin compose desde el repositorio oficial: https://docs.docker.com/engine/install/ubuntu/
   sudo usermod -aG docker ubuntu          # cerrar sesión y volver a entrar
   sudo mkdir -p /opt/tracop/staging && sudo chown ubuntu /opt/tracop/staging
   ```

4. En `/etc/ssh/sshd_config`, poner `PasswordAuthentication no` y `PermitRootLogin no`, y luego `sudo systemctl restart ssh`.
5. Rotación de logs de Docker, en `/etc/docker/daemon.json`: `{"log-driver":"json-file","log-opts":{"max-size":"10m","max-file":"5"}}`, y luego `sudo systemctl restart docker`.
6. _Comprobación:_ `docker compose version` responde, y un escaneo externo solo ve los puertos 22, 80 y 443.

### 6.5 DNS y TLS

1. En el DNS, crear el registro `A`: `api-staging.<dominio>` → la IP estática.
2. El `Caddyfile` del cambio 4.3 contiene `api-staging.<dominio> { reverse_proxy api:3000 }` y los tiempos máximos. Caddy obtiene y renueva el certificado solo.
3. _Comprobación,_ tras el §6.6: `curl -I https://api-staging.<dominio>/health` responde `200` con un certificado válido.

### 6.6 Aplicación

1. En `/opt/tracop/staging`, colocar `docker-compose.prod.yml` y el `Caddyfile` del repositorio, en la etiqueta que se despliega.
2. Crear el `.env` a partir de la plantilla del §5.8 y luego `chmod 600 .env`. Los valores se copian del gestor de contraseñas **en el propio servidor**.
3. Si la imagen es privada: `docker login ghcr.io`, con el token de lectura.
4. Arrancar en orden:

   ```bash
   docker compose pull
   docker compose up -d db
   docker compose run --rm migrate          # crea roles, schemas y tablas; se detiene si algo falla
   docker compose up -d api worker caddy backup
   ```

5. Configurar el bucket. Se hace **una vez**, desde la máquina de un operador con su usuario IAM y las variables `S3_*` del entorno:

   ```bash
   pnpm storage:configure-lifecycle         # expira incoming/ y payment-incoming/ a las 24 h
   pnpm storage:configure-cors              # solo si CORS_ALLOWED_ORIGINS no está vacío
   ```

6. Crear el personal: un `admin`, un `operator` y un `finance`. Se ejecuta dentro del contenedor de la API; el comando exacto depende del cambio 4.2:

   ```bash
   docker compose exec api <create-staff> --phone "+57 3XX XXX XXXX" --name "Nombre" --role admin
   ```

7. Registrar el webhook del bot del entorno: `pnpm telegram:set-webhook https://api-staging.<dominio>/webhooks/telegram`.
8. Cargar la taxonomía y los productos del piloto con el usuario `operator`, desde el backoffice o la API (§12). En staging pueden ser sintéticos; en producción, solo los aprobados por producto.

### 6.7 Copias

1. El servicio `backup` hace `pg_dump --format=custom` cada 6 h y conserva 7 copias en el disco.
2. Con el cambio 4.6, cada copia se sube a `s3://tracop-backups-<sufijo>/<entorno>/` con la clave `tracop-backups`.
3. **Prueba de restauración**, en la puesta en marcha y luego cada mes:
   - descargar la última copia en la máquina de un operador;
   - ejecutar `pnpm backup:restore-check <archivo.dump>`, que la restaura en un PostgreSQL desechable y muestra los recuentos;
   - deben coincidir con los de la base del entorno.

### 6.8 Alertas

1. En **UptimeRobot**, plan gratuito, crear dos monitores HTTP cada 5 minutos:
   - `https://api-staging.<dominio>/health`: la API está viva;
   - `https://api-staging.<dominio>/ready`: base de datos y latido del trabajador. Responde 503 si el trabajador no late.
2. En el servidor, un `cron` cada 5 a 15 minutos con los chequeos del §8.3. Todos avisan al canal del equipo.
3. **Probar las alertas:** `docker compose stop worker`. En ≤ 10 min debe llegar el aviso de `/ready`. Luego, `docker compose start worker`.

### 6.9 Producción (más adelante)

Se repiten los pasos 6.3 a 6.8 con los nombres `prod` (`tracop-prod-<sufijo>`, `tracop-prod`, `api.<dominio>`):

- **otra instancia**;
- otro bucket y otros usuarios IAM;
- **otro bot** y **otros secretos**.

**Nunca** se copian datos ni secretos de staging a producción. El despliegue de producción sale de una etiqueta de `main` (`v1.0.0`), con aprobación manual.

## 7. Verificación tras desplegar

Se marca cada punto **en cada despliegue**:

- [ ] **Salud:** `curl -fs https://api-staging.<dominio>/health` → `{"status":"ok"}`.
- [ ] **Disponibilidad:** `curl -fs https://api-staging.<dominio>/ready` → `200`, con la base y el latido del trabajador.
- [ ] **Métricas:** `curl -s -H "Authorization: Bearer <METRICS_TOKEN>" https://api-staging.<dominio>/metrics` devuelve texto de Prometheus. Sin el token debe dar **404**.
- [ ] **Documentación cerrada:** `curl -s -o /dev/null -w '%{http_code}' https://api-staging.<dominio>/docs` → **404**. Swagger no existe fuera de desarrollo.
- [ ] **Cabeceras:** `curl -sI https://api-staging.<dominio>/health` muestra `strict-transport-security` y `x-content-type-options: nosniff`, y no muestra `x-powered-by`.
- [ ] **Solo dos puertos:** desde fuera, PostgreSQL (5432) y la API (3000) no responden.
- [ ] **Webhook:** `getWebhookInfo` del bot muestra la URL correcta, `pending_update_count` cercano a 0 y ningún `last_error_message`.
- [ ] **Recorrido completo con un teléfono:**
  1. registro y OTP por Telegram;
  2. perfil de proveedor y lote con foto;
  3. búsqueda y pedido de un comprador;
  4. comprobante y verificación por `finance`;
  5. viaje y entrega, liquidación.

  El procedimiento está en [LIVE-WALKTHROUGH.md](LIVE-WALKTHROUGH.md).

- [ ] **S3 real:** la foto y el comprobante se suben y se descargan con URL firmada. La clave `post` no puede leer ni borrar.
- [ ] **Outbox:** `docker compose exec api … outbox:status` muestra 0 eventos fallidos.
- [ ] **Copias:** existe una copia de las últimas 6 h en S3, y la restauración de prueba se hizo este mes.

## 8. Operación

### 8.1 Runbook

Se ejecuta en `/opt/tracop/<entorno>` con `docker compose`.

| Situación                           | Qué hacer                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Arrancar**                        | `docker compose up -d` y luego comprobar `/ready`                                                                                                                                                                                                                                                                                                  |
| **Parar**                           | `docker compose stop`. **Nunca** `docker compose down -v`: borra los volúmenes con la base de datos.                                                                                                                                                                                                                                               |
| **Desplegar la versión `vX`**       | `scripts/deploy/deploy.sh vX` (cambio 4.5). Hace copia, migración, arranque de la API y del trabajador, y comprobación de `/ready`. Si un paso falla, se detiene y la versión anterior sigue corriendo.                                                                                                                                            |
| **Revertir**                        | `scripts/deploy/deploy.sh v<anterior>`. Las migraciones solo añaden (_expand/contract_), así que la versión anterior funciona con el esquema nuevo. Si hubo daño en los datos, ir a «Restaurar».                                                                                                                                                   |
| **Restaurar**                       | 1. `docker compose stop api worker`.<br>2. `pg_restore --no-owner --exit-on-error -d <base vacía> <copia.dump>`.<br>3. `docker compose run --rm migrate`.<br>4. `docker compose start api worker`.<br>5. Comprobar `/ready`.<br>Las operaciones de sync posteriores a la copia las reenvían los móviles; la idempotencia evita duplicados.         |
| **La API no responde**              | 1. `docker compose ps`.<br>2. `docker compose logs --tail 200 api`.<br>3. `df -h`.<br>4. `docker compose restart api`.<br>5. Si la máquina no responde, reiniciarla desde la consola de Lightsail.<br>6. Si se perdió, crear una instancia nueva desde la última instantánea, o desde cero y restaurar la copia.<br>**Objetivo:** volver en ≤ 2 h. |
| **`/ready` responde 503**           | El trabajador no late: `docker compose logs --tail 200 worker` y `docker compose restart worker`. Luego revisar el outbox.                                                                                                                                                                                                                         |
| **Disco lleno**                     | `docker system prune` (imágenes viejas) y revisar las copias locales y los logs. Si persiste, ampliar el plan de Lightsail.                                                                                                                                                                                                                        |
| **Webhook de Telegram con errores** | `getWebhookInfo` → `last_error_message`. Suele ser el certificado o la URL. Volver a ejecutar `telegram:set-webhook`.                                                                                                                                                                                                                              |
| **Avisar**                          | Al equipo del móvil, por el canal acordado, si la caída pasa de 15 min. A los usuarios del piloto, por el bot, si pasa de 1 h.                                                                                                                                                                                                                     |

### 8.2 Rotación de secretos

Se **ensaya en staging** antes del piloto. Rotar: generar el valor nuevo, guardarlo en el gestor de contraseñas, editar el `.env` y ejecutar `docker compose up -d api worker`.

| Secreto                   | Efecto al rotarlo                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `JWT_SECRET`              | **Cierra todas las sesiones:** todos deben volver a entrar con OTP. Hay que avisar antes.                                       |
| `OTP_HMAC_SECRET`         | Invalida los OTP en curso (5 min).                                                                                              |
| `RATE_LIMIT_HMAC_SECRET`  | Reinicia los contadores de límite y cambia los seudónimos de IP y de teléfonos expirados. **Solo se rota ante una filtración.** |
| `TELEGRAM_BOT_TOKEN`      | Se revoca en BotFather; luego se reinicia y se vuelve a ejecutar `telegram:set-webhook`.                                        |
| `TELEGRAM_WEBHOOK_SECRET` | Se reinicia y se vuelve a ejecutar `telegram:set-webhook`.                                                                      |
| Claves S3 (`S3_*`)        | Crear la clave nueva en IAM, cambiar el `.env`, reiniciar y **luego** borrar la vieja.                                          |
| `METRICS_TOKEN`           | Actualizarlo también en el `cron` de alertas.                                                                                   |
| Contraseñas de PostgreSQL | `ALTER ROLE … PASSWORD …`, actualizar las URL y reiniciar.                                                                      |
| `LLM_API_KEY`             | Crear la clave nueva en el workspace, cambiarla y revocar la vieja.                                                             |

**Quién tiene acceso:** solo las personas de operación, a través del gestor de contraseñas. Cuando alguien sale del equipo, se rotan todos los secretos que conocía.

### 8.3 Alertas mínimas

| Alerta                              | Cómo se detecta                            | Umbral                                              |
| ----------------------------------- | ------------------------------------------ | --------------------------------------------------- |
| API caída                           | UptimeRobot sobre `/health`                | 2 fallos seguidos                                   |
| Trabajador caído                    | UptimeRobot sobre `/ready` (503)           | 2 fallos seguidos                                   |
| Outbox atascado o trabajos fallidos | `cron` con `outbox:status`                 | Cualquier evento fallido, o pendiente más de 10 min |
| Errores 5xx                         | `cron` sobre `/metrics`                    | Aumento en 5 min                                    |
| Disco                               | `cron` con `df`                            | > 80 %                                              |
| Tablas de sync                      | Consulta de [DEPLOYMENT.md](DEPLOYMENT.md) | > `SYNC_TABLE_ALERT_BYTES`                          |
| Webhook de Telegram                 | `cron` con `getWebhookInfo`                | `pending_update_count` > 50 o un error reciente     |
| Certificado TLS                     | `cron` con `openssl s_client`              | < 14 días para caducar                              |
| Coste de AWS                        | AWS Budgets                                | 50 %, 80 % y 100 %                                  |
| Coste de IA                         | Tope del workspace del proveedor           | Al 80 %                                             |

**Revisión de cada lunes (5 minutos):**

- alertas del fin de semana;
- `docker compose ps`;
- `outbox:status`;
- copias de las últimas 24 h en S3;
- gasto de AWS y de la IA del mes.

### 8.4 Mantenimiento

- **Parches del sistema:** automáticos (`unattended-upgrades`). Revisar cada mes si piden reinicio.
- **Imágenes:** una nueva versión de la aplicación llega como etiqueta; las imágenes base (`postgres:16-alpine`, Caddy) se actualizan una vez al mes con `docker compose pull`.
- **Restauración de prueba:** una vez al mes (§6.7).
- **Logs:** no contienen datos personales (está probado); se conservan según la rotación de Docker.

## 9. Telegram

1. En BotFather, crear **un bot por entorno**: `<nombre>_staging_bot` y `<nombre>_bot`.
   - Guardar el token en el gestor de contraseñas.
   - Configurar nombre, descripción y foto del bot de producción con los textos que apruebe producto.
2. **El webhook necesita HTTPS público con certificado válido.** Lo da Caddy en el 443. Telegram envía en cada petición la cabecera `X-Telegram-Bot-Api-Secret-Token`, que la API compara con `TELEGRAM_WEBHOOK_SECRET`.
3. Registro: `pnpm telegram:set-webhook https://<host>/webhooks/telegram`. Registra los tipos `message` y `callback_query`.
4. **Si la API está caída,** Telegram guarda los mensajes y reintenta; cuánto tiempo los guarda está NO verificado. Al volver, la API procesa cada `update_id` una sola vez.
5. **El OTP llega por Telegram:**
   - el usuario debe abrir el bot y compartir su contacto antes de pedir el código;
   - pasar a SMS o WhatsApp para el piloto real es una **decisión pendiente** (§12), y cuesta dinero por mensaje.
6. **Al cerrar un entorno:** `deleteWebhook` y revocar el token en BotFather.

## 10. IA (opcional)

Se despliega **apagada** (`AI_ENABLED=false`). Para activarla, en este orden:

1. Aviso de privacidad y aviso de IA **aprobados por legal**, con su versión (`PRIVACY_POLICY_VERSION` y `AI_CONSENT_VERSION`).
2. Workspace propio del entorno en la consola del proveedor, con su **tope de gasto mensual**, US$10 al empezar.
3. Una persona del equipo ejecuta `pnpm ai:eval-live` con el modelo elegido. Objetivo: ≥ 90 % de los campos (PROVISIONAL).
4. Definir las variables del §5.4 y reiniciar la API y el trabajador.
5. **Si el proveedor cae, se agota el tope o tarda demasiado,** el bot pasa solo al formulario guiado sin IA; no hay que intervenir. Para apagarla del todo: `AI_ENABLED=false` y reiniciar.

## 11. Lo que se entrega al equipo del móvil

| Qué               | Valor                                                                                                                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| URL base          | `https://api-staging.<dominio>` (y `https://api.<dominio>` en el piloto)                                                                                                               |
| Contrato          | `docs/openapi.json` **de la etiqueta desplegada**, adjunto a cada release. Integrar contra una etiqueta, nunca contra `develop`.                                                       |
| Autenticación     | Teléfono + OTP por Telegram, con JWT de 15 min y refresh rotativo por dispositivo                                                                                                      |
| Bot del entorno   | `@<nombre>_staging_bot`: hay que abrirlo y compartir el contacto antes de pedir el OTP                                                                                                 |
| CORS              | Solo aplica a clientes web; hay que darnos los orígenes exactos                                                                                                                        |
| Cuentas de prueba | Teléfonos del equipo del móvil registrados en staging. El personal (`operator`, `finance`) lo crea operación.                                                                          |
| Límites           | Fotos: hasta 5 por lote, 5 MiB cada una. Sync: 50 operaciones por push, 256 KiB por petición, 30 push y 120 pull por minuto. Búsqueda: 60 por minuto.                                  |
| Aviso             | El OpenAPI tiene operaciones sin la respuesta o el cuerpo documentados (deuda conocida). Hay que avisar al equipo de backend de las rutas que usarán primero, para completarlas antes. |

## 12. Decisiones pendientes que bloquean etapas

| Decisión                                          | Responsable          | Bloquea                     | Propuesta por defecto                                                          |
| ------------------------------------------------- | -------------------- | --------------------------- | ------------------------------------------------------------------------------ |
| Plataforma                                        | Dueño del proyecto   | Todo                        | AWS Lightsail + S3                                                             |
| Dominio                                           | Dueño del proyecto   | Staging                     | `.co` o `.com` propio                                                          |
| Infraestructura de la universidad                 | TI de la universidad | Solo si se elige esa opción | Descartarla sin una confirmación escrita de IP pública, HTTPS y permiso de uso |
| Aviso de privacidad y aviso de IA, con su versión | Legal / dueño        | Piloto (y la IA)            | —                                                                              |
| Taxonomía y productos del corredor piloto         | Producto             | Piloto                      | —                                                                              |
| Comisión, flete y ventanas (§5.5)                 | Producto             | Piloto                      | Los valores por defecto, marcados PROVISIONALES                                |
| Canal del OTP en el piloto                        | Producto             | Piloto                      | Telegram en staging; decidir SMS o WhatsApp antes del piloto                   |
| IA sí o no, y tope                                | Dueño del proyecto   | Activar la IA               | Apagada; luego US$10/mes                                                       |
| RPO de 6 h y RTO de 2 h                           | Dueño del proyecto   | Piloto                      | Esos valores, PROVISIONALES                                                    |
| Procedimiento de supresión de datos (Ley 1581)    | Legal / dueño        | Piloto                      | —                                                                              |
| Canal de alertas y de aviso al equipo del móvil   | Equipo               | Staging                     | Chat de Telegram del equipo                                                    |

## 13. Riesgos conocidos y NO verificado

- **Un solo servidor es un punto único de fallo.** Se mitiga con instantáneas diarias, copias a S3 cada 6 h y la restauración ensayada (RTO 2 h).
- **Escala medida** en la prueba de carga, con una instancia (detalle en [LOAD-TEST.md](LOAD-TEST.md)):
  - con < 1 000 lotes, la búsqueda aguanta unos 35 usuarios concurrentes con p95 ≤ 500 ms;
  - con 10 000 lotes ya no;
  - el push de sync aguanta unos 30 usuarios.

  Es suficiente para el piloto, pero no es una garantía de producción.

- **Tiempos máximos:** la API usa los de Node (300 s por petición). Hay que fijarlos en Caddy (cambio 4.3).
- **NO verificado:**
  - el S3 real (CORS, ciclo de vida, permisos mínimos);
  - Telegram real con un teléfono;
  - la latencia desde Bogotá;
  - los precios marcados como tales;
  - el plan gratuito de AWS para Lightsail;
  - cuánto tiempo retiene Telegram los updates.

  Se verifican en la fase 1 (staging). Los criterios de salida están en [DEPLOYMENT-PLAN.md](DEPLOYMENT-PLAN.md), §14.

## 14. Referencias en el repositorio

| Documento                                  | Para qué                                                                         |
| ------------------------------------------ | -------------------------------------------------------------------------------- |
| [DEPLOYMENT-PLAN.md](DEPLOYMENT-PLAN.md)   | Comparativa de opciones, costes con fuentes y fases con criterios de salida      |
| [DEPLOYMENT.md](DEPLOYMENT.md)             | Perfiles, demo, instancia única, alarma de las tablas de sync, copias y rotación |
| [ENV-CRITICALITY.md](ENV-CRITICALITY.md)   | Criticidad de cada variable                                                      |
| [LIVE-WALKTHROUGH.md](LIVE-WALKTHROUGH.md) | Recorrido de verificación con Telegram real y un teléfono                        |
| [SECURITY-REVIEW.md](SECURITY-REVIEW.md)   | Revisión de seguridad: autorización, secretos, cabeceras, ZAP                    |
| [LOAD-TEST.md](LOAD-TEST.md)               | Capacidad medida                                                                 |
| [AUTHZ-MATRIX.md](AUTHZ-MATRIX.md)         | Qué puede hacer cada rol en cada ruta                                            |
| `docs/openapi.json`                        | Contrato HTTP                                                                    |
