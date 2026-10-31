# Arquitectura

TRACOP adopta un monolito modular con arquitectura hexagonal: los módulos encapsulan dominio, aplicación, puertos y adaptadores; los controladores y adaptadores conectan el exterior con los casos de uso. El dominio no depende de aplicación, adaptadores ni frameworks; aplicación depende de dominio y puertos. Los módulos exponen su superficie pública exclusivamente por `index.ts`.

## Shared

`src/shared/kernel/` contiene elementos compartidos que son parte del lenguaje del dominio y pueden usarse desde `domain`: `Result`, errores base, la interfaz `Clock` e IDs UUID v7. `src/shared/infra/` contiene implementaciones y detalles de infraestructura —validación de entorno, `SystemClock`, Drizzle/PostgreSQL, `UnitOfWork`, outbox, logging Pino y manejo HTTP— y no puede importarse desde el dominio.

`src/shared/auth/` expone `AuthGuard`, `Roles` y los tipos de identidad autenticada. Los controllers de catálogo los usan para exigir sesión en rutas de catálogo/lotes y restringir operaciones de gestión o publicación a los roles correspondientes. El guard comprueba JWT y sesión con el módulo `identity`; `catalog` no implementa autenticación propia.

## Catálogo

El módulo `catalog` posee categorías, productos y lotes. `CatalogController` gestiona categorías/productos; `LotsController` crea y mantiene lotes, publica/cancela y busca lotes visibles. `CatalogService` contiene las reglas de categoría, producto, lote y filtros; Drizzle persiste en el schema `catalog`. Las mutaciones de estado del lote generan eventos del dominio y se escriben a través del outbox compartido.

Las consultas de lotes incluyen filtros de categoría/producto, texto, precio, disponibilidad y ubicación. `search_text` guarda el nombre del producto normalizado (minúsculas y sin diacríticos); cada token de la consulta debe aparecer en ese texto. La búsqueda produce una página y un cursor `nextCursor`. El cursor transporta versión, criterio de ordenación, clave de ordenación e ID como desempate; el controller lo cifra y autentica con AES-256-GCM usando una clave derivada de `JWT_SECRET`, y rechaza cursores inválidos o que no correspondan al orden pedido. El servicio ordena los resultados y avanza después de la tupla de cursor (keyset); actualmente carga y filtra el conjunto visible antes de recortar cada página, no es paginación SQL por cursor.

La respuesta de lote elimina siempre `providerId`, latitud y longitud del objeto público; las coordenadas solo se añaden cuando el viewer es el proveedor propietario. El cálculo de distancia puede incluir `distanceKm`, sin revelar coordenadas del lote. La búsqueda aplica un límite por usuario con `InMemorySearchRateLimiter`, contadores en proceso y ventana fija; sus umbrales y radio máximo vienen de `CATALOG_SEARCH_RATE_LIMIT`, `CATALOG_SEARCH_RATE_WINDOW_SECONDS` y `CATALOG_SEARCH_RADIUS_MAX_KM`.

### `ProviderDirectoryPort`

`LotsController` usa `ProviderDirectoryPort` para enriquecer respuestas con el resumen público del proveedor. El catálogo define el puerto en su superficie pública; `bootstrap/catalog-bridge.module.ts` implementa `IdentityProviderDirectoryAdapter`, que delega a `ProviderProfileService` expuesto por `identity/index.ts`. Así, el catálogo no importa internals ni consulta tablas de identidad.

La decisión del núcleo de catálogo está en [ADR-010](adr/ADR-010.md).

## Messaging (Telegram / WhatsApp)

`messaging` implementa la recepción y envío de mensajes por canal de mensajería. El dominio y la aplicación no conocen Telegram ni WhatsApp; operan sobre `InboundMessage` / `OutboundMessage` definidos en `domain/messaging.ts`.

### Capas

| Capa            | Contenido                                                                                                                                                                                                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `domain/`       | `InboundMessage` (texto, voz, foto, ubicación, contacto, acción), `OutboundMessage` (texto + botones), `ChannelUserRef`, `MessagingError`. Sin dependencias externas.                                                                                                                        |
| `application/`  | `MessagingApplicationService`: `handleUpdate` (idempotente por `updateId`), `handleInboundMessage` (comando `/start` → botón `request_contact`; contacto → vinculación; voz/foto/ubicación → respuesta genérica). Devuelve `UpdateProcessingResult` con réplicas y `securityEvent` opcional. |
| `ports/`        | `MessagingPort` (`sendText`, `sendButtons`), `ChannelIdentityPort` (`linkChannel`, `findActiveChannelByPhone`), `ProcessedUpdatesRepository`, `MessagingUnitOfWork`, `MessagingApplication`.                                                                                                 |
| `adapters/in/`  | `TelegramWebhookController` (valida secret token, timeout, entrega async), `TelegramUpdateHandler` (procesa, rate-limit, delega a aplicación, entrega réplicas), `TelegramPollingRunner` (solo dev, `TELEGRAM_MODE=polling`), `normalizeTelegramUpdate` (zod → `InboundMessage`).            |
| `adapters/out/` | `TelegramAdapter` (grammY, mapea `MessagingError`), `InMemoryMessagingAdapter` (tests), `DrizzleProcessedUpdatesRepository`.                                                                                                                                                                 |

### Puertos

| Puerto                       | Responsabilidad                                              | Adaptadores                                                                       |
| ---------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `MessagingPort`              | Enviar texto y botones                                       | `TelegramAdapter`, `InMemoryMessagingAdapter` (tests), `WhatsAppAdapter` (futuro) |
| `ChannelIdentityPort`        | Vincular canal a teléfono y buscar canal activo por teléfono | `IdentityChannelAdapter` (en `bootstrap/`, delega a `IdentityChannelApplication`) |
| `ProcessedUpdatesRepository` | Idempotencia de updates entrantes (`claim(updateId)`)        | `DrizzleProcessedUpdatesRepository` (tabla `messaging.processed_updates`)         |
| `MessagingUnitOfWork`        | Transacción compartida con `shared.outbox_events`            | `UnitOfWork` de `shared/infra`                                                    |

### Flujo de webhook

1. `POST /webhooks/telegram` recibe update; valida `x-telegram-bot-api-secret-token` con `timingSafeEqual`.
2. `TelegramUpdateHandler.process`: valida con `telegramUpdateSchema` (zod), normaliza, rate-limit por remitente y global (claves HMAC), `ProcessedUpdatesRepository.claim(updateId)`, delega a `MessagingApplicationService.handleUpdate`.
3. Responde **200 OK inmediato**; `TelegramUpdateHandler.deliver(replies)` envía réplicas en background vía `MessagingPort`.
4. Errores de entrega se loguean (hash de `channelUserId`), no reintentan aquí; la cola de notificaciones maneja reintentos en su capa.

### Polling (solo desarrollo)

`TelegramPollingRunner` arranca si `NODE_ENV=development` y `TELEGRAM_MODE=polling`; borra webhook pendiente y usa `bot.on('message')`. Útil para probar sin túnel público.

### Rate limiting

- **Por remitente**: `TELEGRAM_RATE_LIMIT_PER_SENDER` (por defecto 20) en ventana `TELEGRAM_RATE_LIMIT_WINDOW_SECONDS` (60s).
- **Global**: `TELEGRAM_RATE_LIMIT_GLOBAL` (por defecto 300) en la misma ventana.
- Claves HMAC con `RATE_LIMIT_HMAC_SECRET`; contadores en memoria (Redis no requerido en piloto). Exceder → `kind: 'dropped'`, sin réplica.

### Normalización

`normalizeTelegramUpdate` acepta solo `message` de chat `private` con `from`. Descarta `edited_message`, `channel_post`, `my_chat_member`, `callback_query`. Tipos soportados: `text`, `contact`, `voice`, `photo` (último `file_id`), `location`. Otros → `message: null` (ignorado).

### Vinculación de canal

`/start` → botón `request_contact`. Al recibir `contact`:

- Si `contact.user_id !== from.id` → `securityEvent: 'contact_user_mismatch'`, responde aviso de seguridad.
- Si coincide → `ChannelIdentityPort.linkChannel({channel, channelUserId}, phone)` → `IdentityChannelApplication.linkChannel` (en `identity`).
- Resultados: `linked`, `already_linked`, `user_not_found`, `invalid_phone`, `conflict` → respuestas localizadas (`i18n.ts`).

### Variables de entorno (ver `.env.example`)

`TELEGRAM_MODE` (`webhook` | `polling`), `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_API_ROOT`, `TELEGRAM_WEBHOOK_PROCESS_TIMEOUT_MS`, `TELEGRAM_RATE_LIMIT_PER_SENDER`, `TELEGRAM_RATE_LIMIT_GLOBAL`, `TELEGRAM_RATE_LIMIT_WINDOW_SECONDS`.

### Decisión

Ver [ADR-009](adr/ADR-009.md).

## Identity y autenticación

`identity` implementa el registro y la autenticación por teléfono + OTP sin que el dominio conozca NestJS, PostgreSQL ni el canal de entrega. Otros módulos solo pueden importar `IdentityModule` desde su `index.ts`; los detalles están en el [README del módulo](../apps/api/src/modules/identity/README.md) y la decisión en [ADR-008](adr/ADR-008.md).

### Capas

| Capa            | Contenido                                                                                                                                                                                                                                                                                |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `domain/`       | `PhoneNumber` (E.164), `User` (`pending_verification`/`active`/`suspended`), `Otp` (vigencia, intentos, un solo uso), `Session` (familia, rotación, revocación) y eventos `UserRegistered`, `UserVerified`, `SessionRevoked`. Sin dependencias de aplicación, adaptadores ni frameworks. |
| `application/`  | `IdentityApplicationService`: `registerUser`, `requestOtp`, `verifyOtp`, `refreshSession`, `logout`, `getMe`, `updateMe`. Devuelve `Result<T, DomainError>` para los flujos esperados.                                                                                                   |
| `ports/`        | Interfaces y tokens de inyección (ver tabla de puertos).                                                                                                                                                                                                                                 |
| `adapters/in/`  | `IdentityController` (REST + OpenAPI) y `IdentityAuthGuard` (JWT + RBAC, con metadatos `@Public`/`@Roles`).                                                                                                                                                                              |
| `adapters/out/` | Repositorios Drizzle, `PostgresRateLimiter`, `HmacTokenService`, `HmacPasswordlessHasher` y senders de OTP.                                                                                                                                                                              |

### Puertos

| Puerto                                                                                          | Responsabilidad                                                                   | Adaptadores                                                   |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `TokenServicePort`                                                                              | Emitir y verificar access JWT (asíncrono) y generar refresh tokens aleatorios     | `HmacTokenService` (jose, HS256)                              |
| `OtpSenderPort`                                                                                 | Entregar el código OTP por el canal configurado                                   | `DevelopmentOtpSender` (consola), `InMemoryOtpSender` (tests) |
| `RateLimiterPort`                                                                               | Consumir una cuota en una ventana fija y devolver `retryAfter`                    | `PostgresRateLimiter`                                         |
| `PasswordlessHasherPort`                                                                        | HMAC-SHA256 de OTP, SHA-256 del refresh token y HMAC de claves de rate limit      | `HmacPasswordlessHasher`                                      |
| `UserRepository`, `OtpRepository`, `SessionRepository`, `DeviceRepository`, `ConsentRepository` | Persistencia del módulo en el schema `identity`                                   | `Drizzle*Repository`                                          |
| `IdentityUnitOfWork`                                                                            | Compartir la transacción de PostgreSQL con la escritura en `shared.outbox_events` | `UnitOfWork` de `shared/infra`                                |

`TokenServicePort.issueAccessToken` y `TokenServicePort.verifyAccessToken` son asíncronos porque `jose` resuelve la firma como promesa. `Clock` y `OutboxWriter` son puertos compartidos de `shared`.

### Flujo de autenticación

1. **Registro** (`POST /auth/register`): valida teléfono E.164, rol auto-registrable y versión vigente del consentimiento. Crea usuario `pending_verification`, dispositivo, consentimiento append-only, evento `UserRegistered` y OTP de `registration`. Si el teléfono ya existe y no está suspendido, registra el consentimiento y emite el OTP que corresponda a su estado (`login` si está activa, `registration` si sigue pendiente). Responde con un mensaje genérico que no revela si el teléfono existe.
2. **Solicitud** (`POST /auth/otp/request`): aplica los límites por teléfono (ventana + espera) y por IP antes de crear el OTP; la respuesta también es genérica.
3. **Verificación** (`POST /auth/otp/verify`): consume la cuota por IP, lee el último OTP del propósito con `FOR UPDATE`, valida hash en tiempo constante, vencimiento, uso único e intentos. Al consumirlo activa al usuario (`UserVerified`), revoca la familia previa del dispositivo con motivo `new_login` y crea una familia nueva.
4. **Refresh** (`POST /auth/refresh`): busca la sesión por SHA-256 del refresh con `FOR UPDATE`, exige que `deviceId` coincida y que la sesión esté activa. Rota la sesión anterior y crea una nueva dentro de la misma familia; devuelve access y refresh nuevos.
5. **Logout** (`POST /auth/logout`): revoca la sesión indicada por `sid` con motivo `logout` y emite `SessionRevoked`.
6. **Perfil** (`GET /me`, `PATCH /me`): el `IdentityAuthGuard` valida firma y claims del access token, exige sesión viva, usuario `active`, coincidencia `sub`/`sid`/`did` y rol permitido.

### JWT y configuración

Los access tokens se emiten y validan con `jose@4.15.9` (HS256 fijado en lista blanca; se rechaza `none` y cualquier otro algoritmo), exigiendo `exp`, `iat`, `iss`, `aud` y `jti`, validando `iss`/`aud` y aplicando tolerancia de reloj configurable. Claims propios: `sub`, `role`, `sid` y `did`. `JWT_SECRET` exige al menos 32 bytes; `JWT_ISSUER` y `JWT_AUDIENCE` tienen valores por defecto y `JWT_CLOCK_TOLERANCE_SECONDS` admite como máximo 60 segundos.

Los límites de OTP, confianza de proxy, países y vida de tokens se configuran por entorno. Los valores de OTP y expiración son parámetros iniciales ajustables. En desarrollo el sender imprime el OTP en la terminal con el teléfono enmascarado; en tests se usa sender en memoria. Producción requiere un sender real y no inicia sin configuración. `identity.consents` conserva la aceptación por versión de política y un trigger rechaza `UPDATE`/`DELETE`.

### Concurrencia y reutilización

- El rate limiter usa un `INSERT ... ON CONFLICT DO UPDATE` atómico; con un límite de 3, 20 consumos concurrentes de la misma clave permiten exactamente 3.
- La verificación de OTP bloquea la fila con `FOR UPDATE`; 12 verificaciones concurrentes con código incorrecto nunca superan `OTP_MAX_ATTEMPTS`.
- Dos refresh simultáneos con el mismo token: exactamente uno rota (201) y el otro detecta `rotatedAt`, responde 401, revoca la familia completa con motivo `reuse_detected` y emite `SessionRevoked` por sesión. **El cliente no debe lanzar refresh en paralelo con el mismo token.** La ventana de gracia para redes inestables está propuesta, no implementada (ver ADR-008).

Las pruebas e2e y de repositorio de identity usan PostgreSQL 16 iniciado con Testcontainers; también hay una prueba de redacción de logs que verifica que teléfono, OTP, tokens, `Authorization` e IP no se emiten en claro. Los contadores de rate limit se limpian perezosamente al escribir; la purga periódica con pg-boss queda para una fase posterior. El texto legal del aviso no está incluido; el equipo debe definirlo antes de cambiar `PRIVACY_POLICY_VERSION=v0-draft`.

Cada módulo es dueño de sus datos. La migración inicial creó schemas para `identity`, `catalog`, `ordering`, `logistics`, `payments`, `notifications`, `trust`, `sync`, `backoffice` y `shared`, junto a `shared.outbox_events`. Las migraciones forward-only posteriores agregan las tablas propias de cada módulo al implementar su funcionalidad. `shared.schema_migrations` conserva el estado técnico del runner; no es una tabla de negocio.

## Composición raíz (bootstrap/)

`apps/api/src/bootstrap/` es el único lugar donde se conectan puertos con adaptadores concretos. Ningún módulo conoce los adaptadores de otro; `bootstrap/` importa `index.ts` de cada módulo y wirea:

| Archivo                          | Qué conecta                                                                                                                                           |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.module.ts`                  | Importa `SharedInfraModule`, `IdentityBridgeModule`, `MessagingModule`, `IdentityModule`, `OtpDeliveryModule` y el puente del catálogo.               |
| `identity-bridge.module.ts`      | Expone `IdentityChannelApplication` (puerto de aplicación de `identity`) para que `bootstrap/` pueda adaptarlo.                                       |
| `catalog-bridge.module.ts`       | Implementa `ProviderDirectoryPort` mediante `IdentityProviderDirectoryAdapter`, delegando a `ProviderProfileService` de `identity`.                   |
| `otp-delivery.module.ts`         | Selecciona `OtpSenderPort` según `OTP_SENDER`: `InMemoryOtpSender` (test), `DevelopmentOtpSender` (consola, dev), `TelegramOtpSender` (producción).   |
| `telegram-otp-sender.adapter.ts` | Implementa `OtpSenderPort` usando `IdentityChannelApplication.findActiveChannelLinkByPhone` + `MessagingPort.sendText`. Fire-and-forget, sin bloqueo. |
| `identity-channel.adapter.ts`    | Implementa `ChannelIdentityPort` (de `messaging`) delegando a `IdentityChannelApplication`.                                                           |
| `http.ts`                        | Configuración global de Nest (prefijo, validación, throttler, CORS, Swagger).                                                                         |

**Regla**: los módulos **no** importan `bootstrap/`. `bootstrap/` importa solo `index.ts` públicos. Los adaptadores en `bootstrap/` son los únicos que cruzan límites de módulo.

## Regla de boundaries (eslint-plugin-boundaries)

`eslint.config.js` en la raíz y `packages/config/eslint.config.js` configuran `eslint-plugin-boundaries` para forzar la regla de dependencia del §5.1–§5.3 (AGENTS.md):

- `domain` no importa de `application`, `adapters`, `bootstrap` ni frameworks.
- `application` importa solo de `domain` y `ports`.
- `adapters` importan de `domain`, `ports` y su propio módulo.
- **Prohibido** importar rutas internas de otro módulo (`modules/identity/application/...`). Solo `modules/identity/index.ts`.
- `bootstrap/` importa de `modules/*/index.ts` y `shared/*`.

El CI falla si hay violaciones (`pnpm lint`).

## Envío asíncrono de OTP y límites

`TelegramOtpSender` (en `bootstrap/telegram-otp-sender.adapter.ts`) implementa `OtpSenderPort.send(phone, code)`:

1. Busca canal activo: `identity.findActiveChannelLinkByPhone(phone)`.
2. Si no hay canal vinculado → log `otp_delivery_skipped` (reason: `no_active_channel`) y **retorna sin error**.
3. Si hay canal → `messaging.sendText({channel, channelUserId}, messagingMessages.otp(code))`.
4. Si el envío falla → log `otp_delivery_failed` con `failure` y `channel`; **no reintenta**, **no lanza**, **no bloquea** la respuesta HTTP.

**Consecuencias**:

- `/auth/otp/request` responde 200 aunque el usuario no tenga el bot vinculado o Telegram falle.
- El OTP se genera y persiste en `identity.otp_codes` **antes** de intentar la entrega.
- No hay reintentos automáticos ni cola de entrega en esta capa; si el usuario vincula el bot después, el OTP ya expiró (vigencia `OTP_TTL_SECONDS`, por defecto 300s). El flujo correcto es: usuario vincula bot → solicita OTP de nuevo.
- En desarrollo con `OTP_SENDER=console` (por defecto) el código se imprime en terminal con teléfono enmascarado; en tests usa `InMemoryOtpSender`.
- Producción **requiere** `OTP_SENDER=telegram` y `TELEGRAM_BOT_TOKEN`; la app rechaza el arranque sin configuración real.
