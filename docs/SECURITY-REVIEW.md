# Revisión de seguridad (fase 9)

Fecha: 2026-11-25. Alcance: la API (`apps/api`) y los paquetes del monorepo. Complementa [SECURITY.md](../SECURITY.md) y [AGENTS §16](../AGENTS.md).

## Secretos

| Comprobación                                                                                                                                       | Resultado                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Archivos `.env` en git                                                                                                                             | Solo `.env.example`                                                                                                                                                                               |
| Valores en `.env.example`                                                                                                                          | Todas las variables secretas vacías (`JWT_SECRET`, `OTP_HMAC_SECRET`, `RATE_LIMIT_HMAC_SECRET`, `TELEGRAM_*`, `LLM_API_KEY`, `S3_*`, `MINIO_ROOT_PASSWORD`, `POSTGRES_PASSWORD`, `METRICS_TOKEN`) |
| Patrones de claves en los archivos versionados (AWS `AKIA…`, claves privadas PEM, `sk-ant-…`, tokens de Slack y GitHub, tokens de bot de Telegram) | Ninguno                                                                                                                                                                                           |
| Validación al arrancar                                                                                                                             | `env.ts` (zod): longitud mínima de los secretos; en producción exige Telegram, HTTPS y S3; con `AI_ENABLED=true` exige el modelo, la clave y la versión del consentimiento                        |
| Logs                                                                                                                                               | Redacción de pino para `authorization`, `apiKey`, `x-api-key`, tokens, OTP, teléfono, IP, URL firmadas, `text`, `prompt` y `comment`; no hay `console.log` en `apps/api/src`                      |

## Cabeceras

`helmet@8.3.0` (MIT) en `configureHttp`, para todas las respuestas, incluidos los errores (probado en `test/security-headers.spec.ts`):

- **Respuestas de la API:**
  - `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'`: la API solo devuelve JSON.
  - `Strict-Transport-Security: max-age=31536000; includeSubDomains`.
  - `X-Content-Type-Options: nosniff`.
  - `X-Frame-Options: SAMEORIGIN`.
  - `Referrer-Policy: no-referrer`.
  - `Cross-Origin-Opener-Policy: same-origin`.
  - Sin `X-Powered-By`.
- **`/docs` (Swagger, solo fuera de producción):** la CSP por defecto de helmet, para que la interfaz cargue sus scripts, y sin HSTS.
- **CORS:** lista explícita (`CORS_ALLOWED_ORIGINS`), sin comodines. El webhook de Telegram queda fuera de CORS.

## Límites

| Límite          | Valor                                                                                                                                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cuerpo JSON     | 64 KB, salvo `/sync/push`, que tiene `SYNC_PUSH_MAX_BODY_BYTES`                                                                                                                                             |
| Push de sync    | De 1 a 50 operaciones; el pull, hasta 500                                                                                                                                                                   |
| Límites de tasa | OTP por teléfono e IP (en base de datos). En memoria: búsqueda, propuestas, fotos, sync, pedidos, calificaciones, verificación, ubicación, recomendaciones, IA (por minuto y por día) y webhook de Telegram |
| Archivos        | Fotos y comprobantes con URL prefirmada de vida corta, tipo y tamaño validados; las fotos se recodifican a WebP                                                                                             |
| Consultas       | `lock_timeout` y `statement_timeout` por transacción; el timeout de la base responde 503                                                                                                                    |

Los límites en memoria son por proceso. Con varias instancias de la API se multiplican; está anotado como deuda.

## Dependencias

`pnpm audit --audit-level=high` no reporta ninguna vulnerabilidad alta ni crítica. Hay 3 moderadas, todas en dependencias de desarrollo y pruebas que no llegan a producción:

| Paquete                    | Aviso                                                                    | Por dónde llega                                              |
| -------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `glob` 10.5.0              | [GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4) | `@testcontainers/minio` → `testcontainers` → `archiver`      |
| `minimatch` 9.0.9 y 10.2.6 | [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) | `@typescript-eslint/*` y la misma cadena de `testcontainers` |

Acción: Dependabot las actualizará cuando las dependencias directas publiquen versiones corregidas. Ninguna está en el paquete que se despliega.

Dependencias nuevas de esta fase: `helmet@8.3.0` (MIT, sin dependencias) y `eslint-import-resolver-typescript@4.4.5` (ISC, solo desarrollo).

## Autenticación y autorización

Ya cubiertas por pruebas en fases anteriores:

- JWT HS256 de 15 min, refresh rotativo por dispositivo con detección de reutilización y ventana de gracia de 30 s.
- RBAC por rol en cada caso de uso, y propiedad en la capa de aplicación: un tercero recibe 404.
- El webhook de Telegram verifica su secreto y es idempotente por `update_id`.
- `/metrics` exige un token y lo compara en tiempo constante.
- El personal (`operator`, `finance`, `admin`) solo se crea por CLI, y sus acciones quedan en `audit_log` con la IP como HMAC.

## Aceptación (fase 11)

### Autorización

`apps/api/test/authz-inventory.e2e-spec.ts` recorre las 103 rutas registradas en Nest:

- comprueba que todas, salvo `GET /metrics` y el webhook de Telegram, están en `docs/openapi.json`;
- exige el guard en cada ruta que no está en la lista blanca;
- las llama como anónimo y con cada uno de los 7 roles. El resultado queda en [AUTHZ-MATRIX.md](AUTHZ-MATRIX.md).

`apps/api/test/authz-objects.e2e-spec.ts`:

- el usuario A crea cada recurso y el usuario B lo pide;
- la respuesta debe ser 404 y los datos de A no deben cambiar. El resultado queda en [AUTHZ-OBJECTS.md](AUTHZ-OBJECTS.md).

La prueba encontró tres respuestas 409 que revelaban la existencia del recurso. Ya están corregidas (#73 y #74):

- subir fotos al lote de otro proveedor;
- reordenar las fotos de un lote ajeno o inexistente;
- disputar el pago de otro comprador con una versión incorrecta.

### Secretos

- **gitleaks 8.30.1** (binario oficial, con la suma comprobada contra el `checksums.txt` de esa versión):
  - Recorrió todo el historial (`--log-opts=--all`) y encontró 7 hallazgos, todos falsos positivos: nombres de variables vacías, expresiones `environment.*` y dos literales sintéticos de prueba.
  - Quedan registrados por huella, sin valor, en `.gitleaksignore`. Con ese archivo, el resultado es «no leaks found».
- **Arranque en producción** (`apps/api/test/production-startup.spec.ts`):
  - Producción no arranca con `.env.example` tal como está; el error nombra cada secreto que falta.
  - Tampoco con el sender de consola o el de captura de la demo, con polling ni con S3 sin HTTPS.
  - Tampoco con secretos triviales, de prueba o repetidos (#75).
- **Inventario:** [ENV-CRITICALITY.md](ENV-CRITICALITY.md) clasifica cada variable por criticidad y dice cuáles son secretos que se rotan.

### Dependencias

`pnpm audit`, en todos los niveles: 0 críticas, 0 altas, 3 moderadas y 0 bajas.

- **glob**, GHSA-3g3m-2fjr-6pw4.
- **minimatch**, GHSA-g3hv-75wg-m249.

Las dos llegan solo por dependencias de desarrollo, por ejemplo `testcontainers` → `archiver` → `glob` → `minimatch`. `pnpm audit --prod` responde «No known vulnerabilities found».

### Cabeceras, CORS, límites, tiempos y errores

- **Cabeceras y CORS:** cubiertos por `apps/api/test/security-headers.spec.ts` y `apps/api/test/cors.spec.ts`.
- **Cuerpos:** 64 KiB en general y `SYNC_PUSH_MAX_BODY_BYTES` en `POST /sync/push`.
- **Errores:**
  - Un 500 responde solo «Error interno.».
  - Un error de validación responde «Solicitud inválida.», sin detalles de zod.
  - Un error de dominio responde su código y su mensaje.
  - Ninguno expone pila, SQL ni rutas internas.
- **Tiempos:**
  - El servidor HTTP usa los valores por defecto de Node 22: `requestTimeout` 300 s, `headersTimeout` 60 s y `keepAliveTimeout` 5 s.
  - No hay un tiempo máximo global por petición.
  - En la base de datos, `lock_timeout` y `statement_timeout` se aplican solo en las transacciones de pedidos.
  - Queda como deuda: fijar tiempos en el balanceador o en la API antes de producción.

### OWASP ZAP 2.17.0

Imagen `ghcr.io/zaproxy/zaproxy@sha256:9624669db72f54d86c4b46a7064518bd9bf79d8c61a4c31befa9923489f328af`. El escaneo fue solo pasivo, contra la demo local y con datos sintéticos.

- **`zap-baseline`** sobre `/health`: 0 fallos y un aviso informativo, 10049 (contenido almacenable en caché en `/` y `/health`, que no llevan `Cache-Control`).
- **`zap-api-scan -S`** (modo seguro, sin escaneo activo) sobre las 120 URL del documento OpenAPI, con la sesión de un comprador sintético: 0 fallos, 0 avisos y dos alertas informativas:
  - 100000: respuestas 4xx, esperadas con ids ficticios;
  - 10049.

## Pendiente

- Revisión externa (pentest) antes de producción.
- Límites de tasa compartidos entre instancias, por ejemplo en PostgreSQL como los de OTP.
- Tiempos máximos de petición y de consulta para todas las rutas, no solo las de pedidos.
