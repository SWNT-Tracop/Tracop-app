# Integración con la app móvil

Guía para el equipo de la app móvil. El contrato vinculante es [`docs/openapi.json`](openapi.json) junto con `packages/contracts` (esquemas zod que comparten la API y la app). Este documento resume el comportamiento que importa al cliente; el detalle de rutas está en [`docs/API.md`](API.md).

## Política de contratos

- Los cambios compatibles solo añaden (rutas, campos opcionales, códigos nuevos documentados).
- Un cambio incompatible (quitar o renombrar campos, cambiar el estado HTTP o el `code` de un error) se marca con la etiqueta **BREAKING** en el PR y se anota en [Cambios BREAKING](#cambios-breaking) antes de integrarse.
- Decidan siempre por el campo `code` del error, que es estable; el estado HTTP es orientativo.

## Autenticación y sesiones

Todas las rutas exigen `Authorization: Bearer <accessToken>` salvo las públicas de `/auth`.

| Paso                | Ruta                                                | Cuerpo                                                                                                                                                                                  | Respuesta                                                                                                            |
| ------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Registro            | `POST /auth/register` (pública)                     | `phone`, `role` (`producer`, `supplier`, `buyer`, `carrier`), `fullName`, `locale?`, `deviceId` (UUID), `platform` (`ios`, `android`, `web`, `other`), `consent: { accepted, version }` | 201 `{ message, botLink }` genérico: no revela si el teléfono ya existe; `botLink` abre el bot que entrega el código |
| Pedir OTP           | `POST /auth/otp/request` (pública)                  | `{ phone }`                                                                                                                                                                             | 201 `{ message, botLink }`                                                                                           |
| Verificar OTP       | `POST /auth/otp/verify` (pública)                   | `phone`, `code` (4–10 dígitos), `deviceId`, `platform`                                                                                                                                  | 201 `{ accessToken, refreshToken, accessTokenExpiresIn, refreshTokenExpiresAt, user }`                               |
| Renovar             | `POST /auth/refresh` (pública)                      | `refreshToken`, `deviceId`                                                                                                                                                              | 201, mismo formato que verificar                                                                                     |
| Cerrar sesión       | `POST /auth/logout`                                 | —                                                                                                                                                                                       | 201                                                                                                                  |
| Perfil              | `GET /me`, `PATCH /me` (`fullName?`, `locale?`)     |                                                                                                                                                                                         | 200                                                                                                                  |
| Perfil de proveedor | `PUT /me/provider-profile` (`producer`, `supplier`) | `displayName`, `municipality`, `department`, `lat`, `lng`, `description`                                                                                                                | 200 `{ status: "saved" }`                                                                                            |

- El access token dura `ACCESS_TOKEN_TTL_SECONDS` (900 s) y el refresh `REFRESH_TOKEN_TTL_SECONDS` (30 días). El OTP vale 300 s y admite 5 intentos.
- **El refresh rota**: cada renovación devuelve un refresh nuevo y el anterior deja de servir. Reutilizar uno ya rotado revoca toda la familia de sesiones del dispositivo y responde 401 `session_invalid`. Si la respuesta de un refresh se pierde (red inestable), reintentar con el **mismo** refresh dentro de `REFRESH_GRACE_SECONDS` (30 s) devuelve un par nuevo, siempre que el refresh que se perdió no se haya usado; pasado ese tiempo, o si ya se usó, es reutilización y se revoca la familia. Guarden siempre el último par recibido. El refresh está atado al `deviceId`.
- Iniciar sesión de nuevo en un dispositivo revoca su sesión anterior.
- Límites: 3 OTP por teléfono cada 10 min y 1 por minuto; 30 solicitudes y 60 verificaciones por IP cada 10 min (429 con `Retry-After`).
- Nunca guarden ni registren tokens ni URLs firmadas en logs.

## Sincronización sin conexión

- `POST /sync/push`: de 1 a 50 operaciones `{ opId (UUID v7), entity, entityId, type: create | update | transition | delete, payload, baseVersion? }`, cuerpo de hasta 256 KiB. Cada operación devuelve `applied`, `rejected` o `conflict` (con `code` y, si aplica, `serverVersion`) dentro de una respuesta 200; los fallos de negocio no son errores HTTP.
- **Idempotencia por `opId`**: repetir la misma operación devuelve el resultado guardado; reutilizar un `opId` con otro contenido devuelve `rejected` con `op_id_reused`. Si una operación falla, las siguientes de la misma `entity:entityId` en ese lote se rechazan con `dependency_failed`; las demás siguen.
- **Concurrencia optimista**: `update`, `transition` y `delete` llevan `baseVersion`; usen el `serverVersion` de la operación exitosa anterior para la siguiente. Un `conflict` obliga a hacer pull y reintentar.
- `GET /sync/pull?cursor=&limit=`: cursor numérico del servidor (no una marca de tiempo), `limit` 1–500 (200 por defecto). Guarden el `nextCursor` recibido sin modificarlo y sigan pidiendo mientras `hasMore` sea `true`. Apliquen un cambio solo si su versión es más reciente que la local. Un `delete` con `payload.tombstone: true` es un borrado que deben conservar.
- Entidades: pull entrega `category`, `product`, `lot`, `trip`, `checkin`, `incident` y `notification` (la bandeja, solo del propio usuario). Push acepta `lot` (dueño del lote), `trip` (`create`; `transition` solo con `payload.action: "start"`), `checkin` (`create`), `incident` (`create`) y `carrier_profile` (`create`/`update`, `entityId` = el propio usuario).
- Visibilidad: la taxonomía aprobada es global; lotes, propuestas de producto pendientes, viajes y check-ins solo los recibe su dueño. Una propuesta rechazada llega a su proponente como `delete` con `rejectionReason`.
- **Pedidos y pagos no entran en sync**: solo en línea.
- Límites: 30 push y 120 pull por usuario cada 60 s (429).

## Fotos de lotes

1. `POST /lots/{id}/photos` con `{ photoId: "<UUID v7>" }` reserva la foto y devuelve `uploadPolicy: { url, fields, expiresAt }`.
2. Suban el archivo **directamente** al almacenamiento con un POST multipart a `url`, enviando todos los `fields` y el archivo al final. No pasa por la API.
3. `POST /lots/{id}/photos/{photoId}/confirm` procesa la imagen (JPEG, PNG o WebP; se re-codifica a WebP sin metadatos). Puede responder `processing`: reintenten la confirmación.
4. Las lecturas de lotes incluyen `photos: [{ id, position, url }]` (la búsqueda, solo la primera). Las URLs firmadas caducan: no las guarden.

Ordenar: `PATCH /lots/{id}/photos/order`; borrar: `DELETE /lots/{id}/photos/{photoId}`. Solo el dueño del lote. Límites de cantidad, tamaño y frecuencia en el [README](../README.md#lot-photos).

## Pedidos

- `POST /orders` (comprador): `id` UUID v7 generado por la app, 1–20 líneas de **un solo proveedor**. El pedido nace `quoted` con la cotización: `subtotal`, `freight`, `commission`, `total`, `providerNet` y `quoteValidUntil`. Importes y cantidades son **cadenas** de enteros (pesos y milésimas). Reenviar la misma petición con el mismo `id` es seguro (devuelve el mismo pedido).
- La comisión, el flete y las vigencias son parámetros que el personal puede cambiar: cada pedido conserva los valores con que se cotizó. Muestren siempre los importes y `quoteValidUntil` que devuelve la API; no los calculen en la app.
- `POST /orders/{id}/accept` con `{ expectedVersion }`: solo el comprador. Reserva el stock durante 24 h (configurable).
- `POST /orders/{id}/cancel` con `{ expectedVersion, reason? }`: comprador o proveedor, solo antes del pago.
- Si nadie acepta, la cotización vence a las 24 h y el pedido pasa a `cancelled` con `cancelReason: "expired"`. Si se acepta y no se paga, al vencer la reserva pasa a `cancelled` con `"reservation_expired"`.
- El comprador ve `deliveryAddress`, `deliveryWindow` y el resumen público del proveedor; el proveedor (`GET /orders/incoming`) nunca ve dirección ni identidad del comprador.

### Estados

- **Pedido**: `quoted → accepted → payment_pending → paid → pickup_scheduled → in_transit → delivered → closed`; `cancelled` antes del pago; `disputed → closed` si el comprador disputa un pedido pagado.
- **Lote**: `draft → published ↔ reserved → sold_out`, `expired`, `cancelled`. `sold_out` llega cuando pagos verificados consumen todo el lote.
- **Pago**: `pending → proof_uploaded → verified → held → settled`; `rejected`; `disputed → held | refunded`.
- **Viaje**: `planned → assigned → in_progress → completed`, o `cancelled`.

## Pagos

El comprador paga por transferencia o Nequi fuera de la app y sube una foto del comprobante; finanzas lo revisa. Solo en línea (no entra en sync). Detalle de rutas en [`docs/API.md`](API.md#pagos).

1. Con el pedido `accepted`, `POST /orders/{orderId}/payment` con `{ id: "<UUID v7>", method }`. Reintentar es seguro: mientras haya un pago abierto se devuelve ese mismo (200).
2. `POST /payments/{id}/proof` devuelve una política de carga, igual que las fotos de lotes: suban la imagen (JPEG, PNG o WebP) directo al almacenamiento y luego `POST /payments/{id}/proof/confirm`. Desde ahí el stock queda retenido: el pedido no se cancela por vencimiento mientras se revisa.
3. Consulten el estado con `GET /orders/{orderId}/payment`. Si se rechaza (`status: rejected`, con `rejectionReason`), el pedido sigue `payment_pending` unas horas (`PAYMENT_REJECTION_GRACE_HOURS`): inicien **otro** pago con un `id` nuevo; reutilizar el anterior da 409.
4. Verificado, el pedido pasa a `paid` y entra en logística. Desde entonces, y hasta que se emitan las liquidaciones (`PAYMENT_CLAIM_WINDOW_HOURS` después de la entrega), el comprador puede disputar (`POST /payments/{id}/dispute`).

`proofUrl` es una URL firmada de corta duración: muéstrenla, no la guarden. El proveedor no ve el pago: sabe que está pagado por el estado del pedido. Productores, proveedores y transportistas ven sus liquidaciones en `GET /settlements`.

## Notificaciones

- La bandeja (`GET /me/inbox`, más recientes primero) también llega por sync como `notification` con `{ id, kind, title, body, createdAt, readAt }`: muéstrenla offline y marquen leído con `POST /me/inbox/{id}/read` cuando haya señal (es idempotente).
- Los textos ya vienen redactados en español; usen `kind` solo para el ícono o la navegación. No contienen direcciones ni datos de otros usuarios.
- Preferencias en `GET`/`PUT /me/notification-preferences`: orden de canales y horario sin molestias (hora de Colombia). Hoy solo Telegram entrega fuera de la app; push llegará con FCM.

## Confianza

- Tras recibir un pedido pagado, el comprador puede calificar al proveedor y, si lo hubo, al transportista: `POST /trust/ratings` con un `id` UUID v7 generado por la app (reintentar con el mismo `id` es seguro) y `score` de 1 a 5, durante 7 días tras la entrega. Fuera de eso la API responde 404; no muestren el botón.
- El bloque `provider` de lotes y pedidos trae `verified`, `rating` (texto con un decimal, por ejemplo `"4.3"`, o `null` mientras haya pocas calificaciones) y `ratingsCount`. Muestren `rating` tal cual; no calculen promedios.
- Productores, proveedores y transportistas ven su reputación en `GET /trust/me`. Los comentarios llegan como textos sueltos: no tienen pedido ni fecha, y su orden no es cronológico a propósito.
- El proveedor solicita la verificación con `POST /trust/verification-requests`; el estado aparece en `GET /trust/me` (`verification`).

## Precios, recomendaciones y alertas

- Al publicar, el productor puede pedir `GET /pricing/suggestion?productId=&unit=`. Muestren el rango (`low`–`high`) como sugerencia con su fuente y fecha, y la cita cuando venga (`citation`). Si llega `insufficient_data`, no muestren nada.
- El comprador ve `GET /recommendations/lots`. Cada lote trae `reasons` en códigos; los textos los pone la app (por ejemplo `reorder` → «Ya lo compraste»). Para el detalle usen `GET /lots/{lotId}`. Envíen `lat` y `lng` juntos si quieren la razón `nearby`; reenvíen `nextCursor` tal cual.
- Alertas: `POST /alerts` con un `id` UUID v7 generado por la app; el aviso llega a la bandeja como `lot_alert`.

## Errores y límites

Formato: `{ statusCode, code?, message, details?, suggestions? }`; los 429 traen `Retry-After` (segundos). Errores de validación: 400 sin `code`. Cuerpo máximo: 64 KiB (256 KiB en `/sync/push`, 413 si se supera).

| Estado | Significado para la app                                            | Códigos frecuentes                                                                                                                                                                                                                                                                                 |
| ------ | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | Petición mal formada: corrijan los datos                           | validación, `duplicate_lot_line`, `multiple_providers`                                                                                                                                                                                                                                             |
| 401    | Sesión inválida o vencida: renueven o vuelvan a entrar             | `session_invalid`, `session_expired`, `invalid_otp`, `otp_expired`                                                                                                                                                                                                                                 |
| 403    | El rol no puede hacer esto                                         | `forbidden`, `invalid_role`                                                                                                                                                                                                                                                                        |
| 404    | No existe **o no es suyo** (no se distingue a propósito)           | `not_found`                                                                                                                                                                                                                                                                                        |
| 409    | Conflicto con el estado actual: refresquen y reintenten o informen | `version_conflict`, `invalid_transition`, `quote_expired`, `lot_unavailable`, `insufficient_stock`, `assignment_conflict`, `invalid_order_status`, `reservation_expired`, `proof_upload_missing`, `settlement_issued`, `product_similar_exists`, `product_pending_review`, `pending_limit_reached` |
| 429    | Demasiadas peticiones: esperen `Retry-After`                       | `rate_limited`, `otp_attempts_exceeded`                                                                                                                                                                                                                                                            |
| 503    | Base de datos ocupada: reintenten más tarde                        | `lock_timeout`, `statement_timeout`, `storage_unavailable`                                                                                                                                                                                                                                         |

Lista completa por código en [`docs/API.md`](API.md#http-errors).

## Comportamientos a tener en cuenta

### Un lote totalmente reservado responde 404 a los compradores

La visibilidad pública depende de la **cantidad disponible** (cantidad del lote menos las reservas activas y vigentes), no solo del estado:

- `GET /lots` lista lotes `published` o `reserved` vigentes **con cantidad disponible mayor que 0**.
- `GET /lots/{id}` responde **404** a compradores y terceros si el lote no está vigente o su cantidad disponible es 0. Su dueño lo sigue viendo siempre (por ejemplo, `status: reserved` y `availableQuantityMilli: "0"` cuando pedidos aceptados reservaron todo).

Un lote reservado solo en parte sigue siendo visible con la cantidad restante. Si una reserva se libera (cancelación o vencimiento), la cantidad vuelve a estar disponible y el lote reaparece.

### Ubicaciones

Nadie recibe las coordenadas exactas de un lote salvo su dueño; los demás ven `distanceKm` redondeado cuando buscan por cercanía. Logística maneja zonas de texto (municipio), con una excepción para el transportista asignado (también `operator` y `admin`):

- `GET /logistics/trips/{id}/stops/{stopId}/location`: la recogida devuelve `points` (coordenadas de los lotes del pedido, hasta 20) y la entrega `address`. Solo con el viaje `assigned` o `in_progress` y la parada sin completar; si no, 404.
- `GET /logistics/trips/{id}/location-pack`: las paradas pendientes con `expiresAt`, para trabajar sin señal. Descárguenlo al iniciar el viaje con señal.
- **Obligatorio en la app:** guarden el paquete **cifrado** (almacenamiento seguro del sistema), no lo registren ni lo envíen a analítica, y **bórrenlo** al completar o cancelar el viaje y al llegar `expiresAt` (24 h como máximo hoy, PROVISIONAL). No llega por sync, a propósito.
- Las respuestas llevan `Cache-Control: no-store`; cada consulta queda auditada y hay un límite por usuario (429 con `Retry-After`).

## Cambios BREAKING

| PR  | Cambio                                                                                                               | Antes                        | Ahora                          |
| --- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------ |
| #50 | `POST /logistics/trips` con un pedido no pagado                                                                      | 400 `invalid_order_status`   | **409** `invalid_order_status` |
| #50 | `POST /logistics/trips` con un pedido que ya está en otro viaje; `assign`/`reassign` en conflicto                    | 400 `assignment_conflict`    | **409** `assignment_conflict`  |
| #50 | Dos transportistas crean a la vez un viaje con el mismo pedido (quien pierde)                                        | 409 o 400 según el momento   | **409**                        |
| #52 | `POST /orders/{id}/accept` sobre el pedido de otro comprador                                                         | 200 (se aceptaba, por error) | **404** `not_found`            |
| #52 | `POST /orders/{id}/cancel` siendo tercero (ni comprador ni proveedor)                                                | 403 `access_denied`          | **404** `not_found`            |
| #53 | `invalid_transition` (p. ej. cancelar un pedido pagado, publicar un lote ya publicado, iniciar un viaje ya iniciado) | 400                          | **409**                        |
| #53 | `quote_expired`, `lot_unavailable`, `reservation_conflict`                                                           | 400                          | **409**                        |

En todos los casos el cuerpo y el `code` no cambian; solo el estado HTTP (y en #52, el resultado indebido pasa a 404). Las validaciones de la petición siguen en 400.
