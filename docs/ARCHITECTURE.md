# Arquitectura

TRACOP adopta un monolito modular con arquitectura hexagonal: los módulos encapsulan dominio, aplicación, puertos y adaptadores; los controladores y adaptadores conectan el exterior con los casos de uso. El dominio no depende de aplicación, adaptadores ni frameworks; aplicación depende de dominio y puertos. Los módulos exponen su superficie pública exclusivamente por `index.ts`.

## Shared

`src/shared/kernel/` contiene elementos compartidos que son parte del lenguaje del dominio y pueden usarse desde `domain`: `Result`, errores base, la interfaz `Clock` e IDs UUID v7. `src/shared/infra/` contiene implementaciones y detalles de infraestructura —validación de entorno, `SystemClock`, Drizzle/PostgreSQL, `UnitOfWork`, outbox, logging Pino y manejo HTTP— y no puede importarse desde el dominio.

`src/shared/auth/` expone `AuthGuard`, `Roles` y los tipos de identidad autenticada. Los controllers de catálogo los usan para exigir sesión en rutas de catálogo/lotes y restringir operaciones de gestión o publicación a los roles correspondientes. El guard comprueba JWT y sesión con el módulo `identity`; `catalog` no implementa autenticación propia.

## Catálogo

El módulo `catalog` posee categorías, productos y lotes. `CatalogController` gestiona categorías/productos; `LotsController` crea y mantiene lotes, publica/cancela y busca lotes visibles. `CatalogService` contiene las reglas de categoría, producto, lote y filtros; Drizzle persiste en el schema `catalog`. Las mutaciones de estado del lote generan eventos del dominio y se escriben a través del outbox compartido.

Las consultas de lotes incluyen filtros de categoría/producto, texto, precio, disponibilidad y ubicación. `search_text` guarda el nombre del producto normalizado (minúsculas y sin diacríticos); cada token de la consulta debe aparecer en ese texto. La búsqueda produce una página y un cursor `nextCursor`. El cursor transporta versión, criterio de ordenación, clave de ordenación e ID como desempate; el controller lo cifra y autentica con AES-256-GCM usando una clave derivada de `JWT_SECRET`, y rechaza cursores inválidos o que no correspondan al orden pedido. El servicio ordena los resultados y avanza después de la tupla de cursor (keyset); actualmente carga y filtra el conjunto visible antes de recortar cada página, no es paginación SQL por cursor.

La respuesta de lote elimina siempre `providerId`, latitud y longitud del objeto público; las coordenadas solo se añaden cuando el viewer es el proveedor propietario. El cálculo de distancia puede incluir `distanceKm`, sin revelar coordenadas del lote. La búsqueda aplica un límite por usuario con `InMemorySearchRateLimiter`, contadores en proceso y ventana fija; sus umbrales y radio máximo vienen de `CATALOG_SEARCH_RATE_LIMIT`, `CATALOG_SEARCH_RATE_WINDOW_SECONDS` y `CATALOG_SEARCH_RADIUS_MAX_KM`.

`ChangeRecorderPort` hace parte de la superficie pública de catálogo (`catalog/index.ts`). El catálogo registra los cambios de categorías, productos y lotes después de mutaciones exitosas, dentro de la unidad de trabajo del catálogo. En la aplicación en ejecución, `CatalogChangeRecorderAdapter`, en `bootstrap/`, delega `record` y `recordBaselineIfAbsent` al `SyncRepositoryPort` público; el adaptador no accede directamente a las tablas de sync. El backfill del catálogo usa `recordBaselineIfAbsent` para insertar un cambio inicial solo cuando esa entidad no tiene historial registrado.

### `ProviderDirectoryPort`

`LotsController` usa `ProviderDirectoryPort` para enriquecer respuestas con el resumen público del proveedor. El catálogo define el puerto en su superficie pública; `bootstrap/catalog-bridge.module.ts` implementa `IdentityProviderDirectoryAdapter`, que delega a `ProviderProfileService` expuesto por `identity/index.ts`. Así, el catálogo no importa internals ni consulta tablas de identidad.

La decisión del núcleo de catálogo está en [ADR-010](adr/ADR-010.md).

## Sync

`sync` expone `POST /sync/push` y `GET /sync/pull`, ambos autenticados. Push valida hasta 50 operaciones, las procesa en el orden recibido y devuelve un resultado individual `applied`, `rejected` o `conflict`. Pull usa un cursor numérico `server_seq` opaco para el cliente y devuelve los cambios visibles para el usuario autenticado (cambios asociados a su propiedad y cambios sin propietario). La taxonomía de `sync.change_log` admite `category`, `product`, `lot`, `trip`, `checkin` e `incident`; logística escribe cambios de viaje y check-in. La documentación vigente de los endpoints excluye explícitamente la retención/compactación, los datos públicos del catálogo para uso sin conexión, la sincronización de fotos y un worker periódico.

`SyncService` usa `SyncOperationHandlerRegistry`, indexado por entidad, para despachar operaciones mediante `SyncOperationHandlerPort`. La interfaz del handler se exporta desde `sync/index.ts`; los módulos no importan internals de otros módulos. `CatalogLotSyncHandler` se registra en `CatalogSyncBridgeModule`, en `bootstrap/`, y delega las operaciones de creación, actualización, transición y eliminación de lotes al `CatalogService` público. Valida los payloads y las versiones de las operaciones, e informa las versiones del servidor; las transiciones de lote no admitidas se rechazan. `CheckinSyncHandler` se registra en `LogisticsBridgeModule` y delega la creación de check-ins al `CheckinService` público; exige `baseVersion` contra la versión del viaje y rechaza `delete`/`transition`. No hay handlers para `order`, `payment` ni otras entidades.

Los cambios del catálogo y el registro de operaciones de sync comparten una transacción de PostgreSQL. `DrizzleUnitOfWork`, `SyncUnitOfWork` y la unidad de trabajo del catálogo delegan en `DatabaseService.transaction`. `DatabaseService` guarda la transacción activa de Drizzle en `AsyncLocalStorage`; las llamadas anidadas reutilizan esa transacción y, por tanto, las llamadas a repositorios mediante `DatabaseService.current()` participan en ella. Para cada operación de push, esto mantiene atómicos la mutación del catálogo, su fila registrada en el log de cambios y el resultado de la operación procesada. Si un error sale de la transacción de la operación, esta se revierte; los errores del handler se convierten en resultados `rejected`/`conflict` y se guardan como resultados procesados.

`DrizzleSyncRepository` usa bloqueos advisory de PostgreSQL limitados a la transacción. En push, primero adquiere un bloqueo de operación por `opId` y luego consulta `processed_operations`, serializando los reintentos concurrentes del mismo ID; después verifica el usuario autenticado y un hash canónico del payload para devolver un resultado previo idéntico o rechazar la reutilización. Los cambios nuevos y las verificaciones de baseline adquieren un bloqueo de secuencia aparte justo antes de asignar e insertar la secuencia. Cuando se necesitan ambos bloqueos, el orden es siempre: operación y luego secuencia. El bloqueo de secuencia global se conserva hasta terminar la transacción y serializa la asignación de `server_seq`, lo que mantiene el orden usado por la paginación de pull; el costo es que la escritura del log de cambios puede competir por ese bloqueo. El repositorio persiste los resultados de idempotencia en `sync.processed_operations` y los cambios en `sync.change_log`.

### Lot photos

`LotPhotoService` reserves and processes photos through `StoragePort` and `PhotoProcessorPort` (shared ports in `shared/ports`, wired by `StorageModule` in `shared/infra/storage`, so other modules such as payments can store files); `S3StorageAdapter` implements S3-compatible storage and `SharpPhotoProcessorAdapter` validates/normalizes images. Keys are random: uploads use `incoming/` and outputs use `photos/`.

1. An authorized provider calls `POST /lots/:id/photos` with a UUID v7 `photoId`. The API checks limits, lot state, and ownership; persists a `pending` reservation; and returns a presigned POST policy (URL, fields, expiry). The client uploads the file directly to the bucket, not through the API.
2. `POST /lots/:id/photos/:photoId/confirm` claims the reservation by transitioning to `processing` with a lease token and expiry. The API checks size/format, processes JPEG/PNG/WebP, and writes a WebP output under `photos/`. Completion requires the lease token; an expired lease can be claimed again. The original and temporary objects are deleted on a best-effort basis; failures are left for orphan purging.
3. Only `ready` photos appear in reads. The API creates presigned download URLs; lot lists include at most one photo and lot details include all photos. Responses contain `id`, `position`, and `url`, not independent `mediaRef`/`objectKey` fields.
4. `catalog:purge-orphan-photos` expires pending reservations and deletes unreferenced objects in `incoming/` and `photos/` that exceed the configured grace period. It is a manual/externally scheduled command; the bucket is not automatically cleaned.

Limits, expiries, quality, concurrency, lease, and rate limits use `CATALOG_PHOTO_*`; defaults are documented in the [README](../README.md#lot-photos). See [ADR-011](adr/ADR-011.md) for consequences and dependencies.

## Logística

`logistics` posee perfiles de transportista, viajes, paradas, check-ins e incidencias en el schema `logistics`. `LogisticsController` expone la API REST; `CarrierProfileService`, `TripPlanningService`, `CheckinService` e `IncidentService` contienen los casos de uso; `DrizzleLogisticsRepository` persiste en PostgreSQL. Las mutaciones relevantes escriben eventos en `shared.outbox_events` y los cambios de viaje/check-in se registran en `sync.change_log` mediante el puerto `LogisticsChangeRecorder`.

### Capas

| Capa            | Contenido                                                                                                                                                                                                                                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `domain/`       | `Carrier`, `Trip`, `TripStop`, `Checkin`, `Incident`, `TRIP_STATES`, `TRIP_TRANSITIONS`, `recommendStops` y `zoneFromAddress`. Reglas de transición y recomendación sin frameworks ni coordenadas.                                                                                            |
| `application/`  | `CarrierProfileService`, `TripPlanningService` (recomendar, crear, asignar/reasignar, iniciar, completar, cancelar, detectar conflictos), `CheckinService` (registrar check-in HTTP y sync) e `IncidentService`.                                                                              |
| `ports/`        | `LogisticsRepository`, `LogisticsUnitOfWork`, `LogisticsClock`, `LogisticsChangeRecorder`, `OrderingLogisticsPort` y `ProviderZonePort`, con sus tokens de inyección.                                                                                                                         |
| `adapters/in/`  | `LogisticsController` y los manejadores de sync `TripSyncHandler` (`trip`: `create` y la transición `start`), `CheckinSyncHandler` (`checkin`), `IncidentSyncHandler` (`incident`: `create`) y `CarrierProfileSyncHandler` (`carrier_profile`). HTTP y sync llegan a los mismos casos de uso. |
| `adapters/out/` | `DrizzleLogisticsRepository` y `InMemoryLogisticsRepository` (tests).                                                                                                                                                                                                                         |

### Puertos

| Puerto                    | Responsabilidad                                                                                              | Adaptador en la composición raíz                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `OrderingLogisticsPort`   | Listar pedidos `paid`, consultar un candidato y transicionarlo a `pickup_scheduled`/`in_transit`/`delivered` | `OrderingLogisticsAdapter`, que delega en `OrderingService.listForLogistics`, `getForLogistics` y `transitionForLogistics`. |
| `ProviderZonePort`        | Obtener la zona textual del proveedor                                                                        | `ProviderZoneAdapter`, que delega en `ProviderProfileService.getProviderPublicSummaries` de `identity`.                     |
| `LogisticsChangeRecorder` | Registrar cambios de viaje y check-in en sync                                                                | `LogisticsChangeRecorderAdapter`, que delega en `SyncRepositoryPort.appendChange`.                                          |
| `LogisticsRepository`     | Persistir el schema `logistics`                                                                              | `DrizzleLogisticsRepository`.                                                                                               |

### Planificación y check-ins

- El transportista crea el viaje desde pedidos en estado `paid`. `TripPlanningService` valida perfil, ausencia de paradas previas y unicidad de pedidos; genera dos paradas por pedido (`pickup` y `delivery`) con `sequence` y `zone`, crea el viaje `planned`, lo asigna al mismo transportista (versión 2) y mueve cada pedido a `pickup_scheduled`.
- La recomendación agrupa por zona textual: recogida desde el perfil público del proveedor y entrega desde la dirección del pedido. Todas las recogidas van antes que las entregas. No existe `MapsPort`, cálculo de distancias ni coordenadas en el esquema o en las respuestas.
- Los estados son `planned → assigned → in_progress → completed`, más `cancelled`. Las transiciones se validan en el dominio y usan `expectedVersion`; el operador solo reasigna después de consultar `GET /logistics/conflicts`.
- `CheckinService.record` verifica rol `carrier`, propiedad del viaje, `baseVersion` contra la versión del viaje, ausencia de check-in previo para la parada/tipo y que la parada no esté completada. Cierra la parada, transiciona el pedido con su versión vigente —obtenida de `ordering.getCandidate`, porque la versión capturada al planear queda obsoleta tras `pickup_scheduled`—, escribe `PickupConfirmed`/`DeliveryConfirmed` y registra el cambio `checkin`. Si ya no quedan paradas pendientes, completa el viaje y registra los cambios `trip` correspondientes.
- `CheckinSyncHandler` valida el payload estricto (`stopId`, `kind`, `clientAt`, `mediaRef?`), exige `baseVersion`, usa `entityId` como ID del check-in y devuelve como `serverVersion` la versión actual del viaje. `delete` y `transition` no están soportados.
- **Ubicación exacta** (fase 5, [ADR-013](adr/ADR-013.md)): `TripLocationService` y `TripLocationController` (archivos nuevos) deciden con `locationAccess` (dominio) quién ve la ubicación de una parada, auditan `location.view` y aplican el límite por usuario (`InMemoryLocationRateLimit`, reloj inyectado). Leen las ubicaciones por `ORDER_LOCATION_PORT`, adaptado en `bootstrap/logistics-location-bridge.module.ts` a `CatalogOrderingApi.getLotLocations` y `OrderingService.getDeliveryDetails`; nada se guarda en el schema de logistics ni en sync.
- Las mutaciones de viaje (`mutateTrip`) y los check-ins leen el viaje con `findTripForUpdate` (`SELECT … FOR UPDATE`) antes de comparar la versión, de modo que dos cambios concurrentes con la misma versión no se aplican ambos. Los check-ins solo se aceptan en viajes `assigned` o `in_progress`; un tercero recibe `not_found`.
- Conflictos: `assignment_conflict`, `invalid_order_status`, `invalid_transition` y `version_conflict` responden 409. Si dos transportistas crean a la vez un viaje con el mismo pedido, gana uno: la versión del pedido en `ordering` lo garantiza (no hay restricción de base de datos al respecto).

La decisión está en [ADR-013](adr/ADR-013.md).

## Propuestas de producto

La taxonomía la cura el personal; `producer` y `supplier` proponen productos (`POST /catalog/product-proposals`) que el personal aprueba o rechaza. `CatalogService` deduplica con `matchProductNames` (dominio): mismo nombre normalizado devuelve el existente, contención de tokens devuelve 409 `product_similar_exists` con sugerencias (salvo `confirm: true`) y el nombre pendiente de otro proveedor devuelve 409 `product_pending_review`. Las respuestas a no-personal se construyen con las vistas de `application/product-views.ts` (sin `proposedBy`, `reviewedBy` ni `reviewedAt`), también en sync. Detalle en [ADR-015](adr/ADR-015.md).

## Pedidos (ordering)

`ordering` posee pedidos, líneas, cotizaciones y eventos encadenados en el schema `ordering`. `OrderingService` crea pedidos ya cotizados (un proveedor, 1–20 líneas, idempotentes por `id`), acepta (solo el comprador; reserva stock vía `LOT_RESERVATION_PORT`), cancela (comprador o proveedor, antes del pago) y expira cotizaciones y reservas. `OrderingMaintenanceService` (público como `ORDERING_MAINTENANCE`) lo expone al trabajador. Los precios se copian del lote por `LOT_QUOTE_PORT`; la comisión y el flete salen de `ORDER_COMMISSION_RATE_BPS` y `ORDER_FREIGHT_COP` (PROVISIONALES). Las reservas viven en `catalog.lot_reservations` y las gestiona catálogo (`CATALOG_ORDERING_API`), con bloqueo de los lotes. La propiedad se comprueba al cargar el pedido; un tercero recibe 404. Detalle en [ADR-014](adr/ADR-014.md).

## Pagos (payments)

`payments` posee el schema `payments`. `PaymentsService` (expuesto como `PAYMENTS_SERVICE`) implementa elegir el medio, preparar y confirmar el comprobante (POST prefirmado por `StoragePort`; re-codificación a WebP por `PhotoProcessorPort`), verificar o rechazar, retener al entregarse, disputar y resolver, emitir y pagar liquidaciones. Habla con ordering por `PaymentOrderPort` (`OrderingPaymentsAdapter`, que delega en los casos de uso de pago de `OrderingService`) y con logistics por `DeliveringCarrierPort` (`TripPlanningService.findDeliveringCarrier`), ambos en `bootstrap/payments-bridge.module.ts`. Ordering, a su vez, retiene, reanuda o consume la reserva por `LOT_RESERVATION_PORT` en `CATALOG_ORDERING_API`. Los casos de uso bloquean el pago, luego el pedido y luego los lotes.

El ledger vive en `ledger_transactions` (una por pedido y tipo) y `ledger_entries`; la base impide modificarlos y exige el balance al confirmar. `OrderDeliveredSubscriber` (`payments.hold-on-delivery`) es el primer consumidor del outbox, y el trabajo `payments.issue-settlements` emite las liquidaciones vencida la ventana de reclamo. Detalle en [ADR-017](adr/ADR-017.md).

## Notificaciones (notifications)

`notifications` posee el schema `notifications`. `NotificationsSubscriber` (`notifications.dispatch`) recibe los eventos del outbox y `NotificationsService.handleEvent` decide los destinatarios, renderiza la plantilla (`domain/templates.ts`), planifica los canales (`planDeliveries`) y escribe la bandeja y las entregas en una transacción, con su cambio `notification` en sync. El trabajo `notifications.send-due` envía las entregas vencidas. Puertos adaptados en `bootstrap/notifications-bridge.module.ts`: `RecipientDirectoryPort` (ordering + `IdentityNotificationDirectory`), `MESSAGING_NOTIFICATION_CHANNEL` (`MessagingPort`) y `NOTIFICATION_CHANGE_RECORDER` (`SyncRepositoryPort`). Push y SMS son `DisabledNotificationChannel`. Detalle en [ADR-018](adr/ADR-018.md).

## Backoffice

`backoffice` posee el schema `backoffice` y es un módulo global: implementa `AUDIT_WRITER` (`DrizzleAuditWriter`, en la transacción del llamador, con el HMAC de la IP tomado del contexto de petición de `shared/infra/request-context.ts`) y `PARAMETER_READER` (`StoredParameterReader`: valor guardado o el de la variable de entorno). Ordering (precio con `ParameterPricingPort`, vigencias), payments (ventanas) y catalog (límite de propuestas) leen los parámetros en cada uso; catalog, payments y logistics auditan sus acciones del personal. `BackofficeService` lista y cambia parámetros, pagina el audit log y entrega métricas que reúne `bootstrap/backoffice-bridge.module.ts` desde la consulta propia de cada módulo (`OrderingService.metrics`, `CATALOG_METRICS`, `PAYMENTS_METRICS`, `NOTIFICATIONS_METRICS`, `OUTBOX_METRICS`). Detalle en [ADR-019](adr/ADR-019.md).

## Recomendaciones y precios (recommendations)

`recommendations` posee el schema `recommendations` y no importa ningún otro módulo de negocio. Sus consumidores del outbox (`recommendations.lot-alerts` para `LotPublished`, `recommendations.price-observations` para `OrderAccepted` y `OrderDelivered`) piden los detalles por las APIs públicas adaptadas en `bootstrap/recommendations-bridge.module.ts` (catalog, ordering y trust). `RecommendationsService` calcula sugerencias de precio con percentiles enteros sobre la referencia DANE-SIPSA importada y las observaciones propias (k ≥ 3, al menos 2 proveedores), puntúa los lotes disponibles con razones en códigos y pesos configurables, y lleva las alertas de precio. El mismo módulo sirve el `PriceSuggestionPort` del asistente (`AssistantPriceBridgeModule`). Detalle en [ADR-022](adr/ADR-022.md).

## Asistente de lotes (ai-assistant)

`ai-assistant` posee el schema `ai_assistant` y no importa ningún otro módulo de negocio. Para los productores vinculados por Telegram, messaging entrega el texto, las ubicaciones compartidas y los toques de botón a `ConversationPort`, que los encola en `ai_assistant.inbox` en la misma transacción que `processed_updates`, con `pg_notify`. El trabajador escucha y vacía la cola (además del trabajo `ai-assistant.drain-inbox`), un mensaje por chat a la vez. `LotDraftAssistant` lleva el borrador: `AiGateway` aplica el interruptor `AI_ENABLED`, el consentimiento de IA, los límites por minuto y por día, y la reserva atómica del tope mensual, antes de llamar a `LLMPort` (`AnthropicLLMAdapter` o `GeminiLLMAdapter`, elegidos por `LLM_PROVIDER`, con `fetch`; `FakeLLMAdapter` en pruebas). El modelo solo extrae fragmentos o elige una etiqueta de una lista cerrada; el código convierte números, unidades y fechas, pregunta un dato a la vez, y solo al confirmar crea y publica el lote por la API pública de catalog en una transacción. `bootstrap/ai-assistant-bridge.module.ts` adapta identity (usuario del chat, ubicación del perfil, consentimiento), catalog y messaging. Detalle en [ADR-021](adr/ADR-021.md).

## Confianza (trust)

`trust` posee el schema `trust` y no importa ningún otro módulo de negocio. `TrustService` registra calificaciones (solo el comprador, pedido entregado con pago verificado, dentro de la ventana), mantiene la reputación con un upsert atómico de enteros, sirve la reputación propia con las reglas de visibilidad de comentarios y lleva la verificación manual de proveedores; las acciones del personal se auditan. `OrderDeliveredTrustSubscriber` (`trust.delivery-stats`) cuenta cada entrega una vez para las métricas internas del transportista. `bootstrap/trust-bridge.module.ts` adapta `OrderDeliveryInfoPort` (ordering `getDeliveryRecord`, logistics `findDeliveringCarrier`, payments `hasVerifiedPayment`) y el `ProviderTrustPort` de catalog y ordering (`TrustService.providerTrust`, en lote). Detalle en [ADR-020](adr/ADR-020.md).

## Trabajador y outbox

`apps/api/src/worker.ts` arranca `WorkerModule` (misma composición que la API) con pg-boss como planificador (`JobSchedulerPort`, colas `singleton`, cron en UTC) y 10 trabajos que llaman a las APIs públicas de mantenimiento: `CATALOG_MAINTENANCE`, `ORDERING_MAINTENANCE`, `IDENTITY_MAINTENANCE`, `MESSAGING_MAINTENANCE`, `PAYMENTS_MAINTENANCE`, `NOTIFICATIONS_MAINTENANCE` y el despachador del outbox. Cada módulo implementa sus purgas con su propio puerto de repositorio (sin SQL en `application/`) y borrado por lotes acotados. `PostgresOutboxDispatcher` reclama eventos con `FOR UPDATE SKIP LOCKED` y un lease, entrega fuera de transacción, registra cada entrega en `shared.outbox_deliveries` y aplica reintentos con espera exponencial y cola de fallidos. Detalle en [ADR-016](adr/ADR-016.md) y [ADR-007](adr/ADR-007.md).

## Almacenamiento y CORS

`S3StorageAdapter` implementa `StoragePort` para cualquier proveedor compatible con S3. El CORS del navegador se configura según el proveedor:

- **S3 con CORS por bucket** (AWS, Supabase): `pnpm storage:configure-cors` aplica `PutBucketCors` con los orígenes de `CORS_ALLOWED_ORIGINS` y comprueba que el bucket los conservó (no verificado contra un S3 real).
- **MinIO**: no implementa CORS por bucket (el script termina con `StorageCorsNotSupportedError`); el CORS es del servidor, `MINIO_API_CORS_ALLOW_ORIGIN`. En `docker-compose.yml` se toma de `MINIO_CORS_ALLOWED_ORIGINS` con valor por defecto `http://localhost:8081`, porque sin configurar MinIO acepta cualquier origen.

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

| Archivo                                  | Qué conecta                                                                                                                                                                                                             |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.module.ts`                          | Define `APPLICATION_MODULES` (`SharedInfraModule`, `AuthModule`, módulos de negocio y puentes), que comparten la API HTTP y el trabajador.                                                                              |
| `identity-bridge.module.ts`              | Expone `IdentityChannelApplication` (puerto de aplicación de `identity`) para que `bootstrap/` pueda adaptarlo.                                                                                                         |
| `catalog-bridge.module.ts`               | Implementa `ProviderDirectoryPort` mediante `IdentityProviderDirectoryAdapter`, delegando a `ProviderProfileService` de `identity`.                                                                                     |
| `catalog-sync-bridge.module.ts`          | Proporciona `CatalogChangeRecorderAdapter` para el puerto público `ChangeRecorderPort` y registra `CatalogLotSyncHandler` en `SyncOperationHandlerRegistry`.                                                            |
| `ordering-bridge.module.ts`              | Implementa `LOT_QUOTE_PORT`, `LOT_RESERVATION_PORT` y `ORDER_PROVIDER_DIRECTORY` delegando en catálogo e identidad.                                                                                                     |
| `logistics-bridge.module.ts`             | Implementa `OrderingLogisticsPort` y `ProviderZonePort`, proporciona `LogisticsChangeRecorderAdapter` y registra los manejadores de sync de `trip`, `checkin`, `incident` y `carrier_profile`.                          |
| `logistics-location-bridge.module.ts`    | Implementa `ORDER_LOCATION_PORT` con las coordenadas de los lotes (catalog) y la dirección del pedido (ordering), APIs internas que ningún controlador expone.                                                          |
| `payments-bridge.module.ts`              | Implementa `PaymentOrderPort` (casos de uso de pago de `OrderingService`) y `DeliveringCarrierPort` (`TripPlanningService`).                                                                                            |
| `notifications-bridge.module.ts`         | Implementa `RecipientDirectoryPort`, el canal de mensajería y el registro de cambios en sync para notifications.                                                                                                        |
| `backoffice-bridge.module.ts`            | Implementa `MetricsSourcesPort` reuniendo las consultas de métricas públicas de cada módulo.                                                                                                                            |
| `trust-bridge.module.ts`                 | `TrustDeliveryBridgeModule` (hechos de entrega para trust) y `ProviderTrustBridgeModule` (reputación pública para catalog y ordering). Dos módulos para no crear un ciclo.                                              |
| `ai-assistant-bridge.module.ts`          | `AiAssistantPortsBridgeModule` (identity, catalog y messaging para el asistente) y `AiAssistantConversationBridgeModule` (`ConversationPort` de messaging → bandeja del asistente). Dos módulos para no crear un ciclo. |
| `recommendations-bridge.module.ts`       | `RecommendationsFactsBridgeModule` (catalog, ordering y trust para recommendations) y `AssistantPriceBridgeModule` (sugerencia de precios para el asistente).                                                           |
| `worker.module.ts`                       | Composición del trabajador: reutiliza `APPLICATION_MODULES` y añade el despachador del outbox (`PostgresOutboxDispatcher`), el planificador (`PgBossJobScheduler`) y `WorkerLifecycle`.                                 |
| `worker-lifecycle.ts` / `worker-jobs.ts` | Arrancan el planificador, registran los 10 trabajos llamando a las APIs públicas de mantenimiento de cada módulo y lo detienen al apagar.                                                                               |
| `otp-delivery.module.ts`                 | Selecciona `OtpSenderPort` según `OTP_SENDER`: `InMemoryOtpSender` (test), `DevelopmentOtpSender` (consola, dev), `TelegramOtpSender` (producción).                                                                     |
| `telegram-otp-sender.adapter.ts`         | Implementa `OtpSenderPort` usando `IdentityChannelApplication.findActiveChannelLinkByPhone` + `MessagingPort.sendText`. Fire-and-forget, sin bloqueo.                                                                   |
| `identity-channel.adapter.ts`            | Implementa `ChannelIdentityPort` (de `messaging`) delegando a `IdentityChannelApplication`.                                                                                                                             |
| `http.ts`                                | Configuración global de Nest (prefijo, validación, throttler, CORS, Swagger).                                                                                                                                           |

**Regla**: los módulos **no** importan `bootstrap/`. `bootstrap/` importa solo `index.ts` públicos. Los adaptadores en `bootstrap/` son los únicos que cruzan límites de módulo.

## Regla de límites entre módulos (ESLint)

`packages/config/eslint.config.js` (usado por `eslint.config.js` de la raíz) impone la regla de dependencia de §5.1–§5.3 de AGENTS.md con **`no-restricted-imports`**:

- Ningún archivo de un módulo importa `adapters`, `ports`, `domain` ni `application` de **otro** módulo; solo su `index.ts`. Los patrones se definen una vez (`CROSS_MODULE_IMPORTS`) y se repiten en cada bloque, porque en la configuración plana un bloque posterior reemplaza las opciones de la regla.
- `domain` no importa `shared/infra`, `application`, `adapters`, `@nestjs/**`, `drizzle-orm` ni `pg`.
- `application` no importa `shared/infra` ni `adapters` (los `*.spec.ts` pueden usar adaptadores en memoria). Los tokens que necesita (por ejemplo `OUTBOX_WRITER`) viven en `shared/ports`.
- `bootstrap/` solo importa los `index.ts` de los módulos y `shared/*`.

`scripts/check-boundaries.mjs` (parte de `pnpm lint`) crea importaciones prohibidas y permitidas y comprueba que ESLint las rechaza o acepta (12 casos). El CI falla si hay violaciones.

`eslint-plugin-boundaries` está configurado (`boundaries/element-types`), pero **no se dispara**: sin un resolvedor de TypeScript, cada import `.js` aparece como «of unknown type». Activarlo requiere `eslint-import-resolver-typescript` (fase de endurecimiento).

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
