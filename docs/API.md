# API conventions

This document records behavior currently implemented by the API. It is not a statement of planned behavior. The generated endpoint contract is available in [OpenAPI](openapi.json).

## Authentication and sessions

- Routes guarded by the API `AuthGuard` require authentication by default. Explicitly public auth routes do not; the internal Telegram webhook is protected by its configured secret header instead. Authenticated requests send `Authorization: Bearer <accessToken>`.
- Endpoints may restrict roles in addition to requiring authentication. A missing/invalid credential returns HTTP 401; a role mismatch returns HTTP 403.
- `POST /auth/refresh` is public and accepts `refreshToken` and `deviceId` in the JSON body. It returns a new access token and refresh token. Refresh tokens are stored as hashes.
- Rotation binds the token to its device and session family. Reuse of an already rotated token revokes the family and returns an invalid-session error. The access-token lifetime defaults to 900 seconds and refresh-token lifetime to 2,592,000 seconds; both are configurable through environment variables.
- Do not put refresh tokens in URLs or logs.

## HTTP errors

The response body is a JSON object. Depending on the error, it contains:

```json
{ "statusCode": 400, "code": "invalid_cursor", "message": "..." }
```

`statusCode` and `message` are present in the shared error format; `code` is included for domain errors and may be absent otherwise. Validation errors return 400 with a generic message. Unhandled errors return 500 with `{"statusCode":500,"message":"Error interno."}`. A 429 response may also include `Retry-After` in seconds. See the endpoint-specific responses in [OpenAPI](openapi.json).

## Pagination

`GET /lots` (visible-lot search) accepts `limit` from 1 to 50 (default 20) and an optional `cursor`. The response contains `items` and, when another page exists, `nextCursor`. The cursor is opaque and encrypted: return it unchanged as the next request's `cursor`; do not parse or modify it. It is bound to the selected sort order, so changing `sort` while reusing a cursor is invalid.

This cursor convention is implemented for catalog lot search; do not assume all list endpoints are paginated this way.

## Sincronización sin conexión

`POST /sync/push` y `GET /sync/pull` requieren `Authorization: Bearer <accessToken>`. El token autenticado aporta el ID de usuario, el rol y el ID de dispositivo (`did`); ninguno de los endpoints acepta `deviceId` en la solicitud. Las solicitudes tienen límite por usuario autenticado y endpoint: por defecto, 30 solicitudes push y 120 pull por ventana de 60 segundos en memoria (`SYNC_PUSH_RATE_LIMIT`, `SYNC_PULL_RATE_LIMIT` y `SYNC_RATE_WINDOW_SECONDS`). El exceso devuelve HTTP 429 y puede incluir `Retry-After`. Estos límites no se coordinan entre instancias de la API.

### Operaciones push

El límite del cuerpo JSON de `POST /sync/push` es 256 KiB. Las demás rutas JSON usan un límite de 64 KiB. El objeto de solicitud y cada operación son estrictos: los campos desconocidos se rechazan con HTTP 400. El cuerpo contiene `operations`, un arreglo de 1 a 50 operaciones:

```json
{
  "operations": [
    {
      "opId": "0190f47a-8b45-7cc2-9a1e-123456789abc",
      "entity": "lot",
      "entityId": "0190f47a-8b45-7cc2-9a1e-123456789abd",
      "type": "create",
      "payload": {}
    }
  ]
}
```

Cada operación tiene un `opId` UUID v7, una cadena `entity` recortada de 1 a 64 caracteres, un `entityId` UUID, un `type` con valor `create`, `update`, `transition` o `delete`, y un `payload` objeto. Si se incluye `baseVersion`, debe ser un entero positivo. Los manejadores push registrados son `lot`, `checkin`, `carrier_profile`, `trip` e `incident`; otras entidades se rechazan en el nivel de la operación.

Para `lot`, `create` debe omitir `baseVersion` y el `id` del payload debe coincidir con `entityId`. `update`, `transition` y `delete` de lotes requieren `baseVersion`, que debe coincidir con la versión actual del servidor. Para operaciones consecutivas sobre un lote, usa el `serverVersion` del resultado exitoso anterior como `baseVersion` de la siguiente operación.

Para `checkin`, el `entityId` es el ID del check-in, se aceptan `create` y `update`, y `baseVersion` es obligatorio también en `create`: compara la versión del **viaje** al que pertenece la parada. El payload estricto es `{ "stopId": "<UUID>", "kind": "pickup" | "delivery", "clientAt": "<ISO>", "mediaRef"?: "<texto>" }`; no admite coordenadas. `delete` y `transition` se rechazan con `unsupported_transition`. El resultado `applied` informa la versión actual del viaje en `serverVersion`.

`opId` es la clave de idempotencia. El servidor calcula SHA-256 sobre la representación JSON canónica de la operación completa. Repetir un `opId` para el mismo usuario y hash reproduce el resultado anterior; reutilizarlo con otro hash devuelve `rejected` con `op_id_reused`, y se rechaza si la operación ya fue registrada para otro usuario. Si una operación falla, las operaciones posteriores de la misma combinación `entity:entityId` en ese lote push se rechazan por dependencia; las entidades independientes no se bloquean.

La respuesta es `{ "results": [...] }`. Cada resultado tiene `opId` y un `status` con valor `applied`, `rejected` o `conflict`; también puede incluir `code` y `serverVersion`. Los códigos de operación definidos por el contrato son `invalid_payload`, `unknown_entity`, `not_found`, `forbidden`, `version_conflict`, `invalid_transition`, `unsupported_transition`, `dependency_failed` y `op_id_reused`. Las discrepancias de versión devuelven `conflict` con `version_conflict` e incluyen `serverVersion` cuando está disponible; en check-ins esa versión es la del viaje. Un check-in duplicado o sobre una parada ya completada devuelve `rejected` con `invalid_transition`. Otros fallos de operación gestionados devuelven `rejected`. La respuesta push no incluye `serverSeq`; el cliente obtiene la secuencia mediante pull. Para borrar un lote, este debe estar en borrador: el borrado exitoso es lógico y el cambio de pull es `delete` con `payload.tombstone: true`. Los lotes publicados se cancelan, no se borran.

### Cambios pull

`GET /sync/pull` acepta los parámetros de consulta opcionales `cursor` y `limit`. `cursor` es un `server_seq` decimal (no una marca de tiempo del cliente), su valor predeterminado es `0` y debe ser una cadena decimal no negativa de máximo 19 dígitos, sin ceros iniciales salvo el valor `0`. `limit` tiene valor predeterminado 200 y debe ser un entero entre 1 y 500. Los parámetros de consulta desconocidos se rechazan.

La respuesta es `{ "changes": [...], "nextCursor": "...", "hasMore": false }`. Los cambios se devuelven en orden ascendente de `server_seq` e incluyen `serverSeq`, `entity`, `entityId`, `op`, `payload` y `occurredAt`. La taxonomía actual del registro de cambios admite las entidades `category`, `product`, `lot`, `trip`, `checkin` e `incident`, y las operaciones `upsert`, `delete` y `cancel`. Logística escribe cambios `trip` y `checkin` con el transportista como propietario; las incidencias publican eventos al outbox pero todavía no escriben en `change_log`. Pull incluye los cambios globales (`owner_user_id IS NULL`) y los que pertenecen al usuario autenticado; también incluye los cambios originados por el dispositivo solicitante. Aplica un cambio solo si la versión de la entidad es más reciente que la versión local. Cuando `hasMore` es `true`, `nextCursor` es la secuencia del último cambio devuelto; de lo contrario, avanza hasta el horizonte global actual de secuencias, incluso sobre filas filtradas por propietario. Guarda y envía de vuelta el cursor recibido sin modificarlo.

### Errores HTTP

Ambas rutas devuelven HTTP 400 si falla la validación de la consulta o del cuerpo, HTTP 401 si falta la autenticación o es inválida, y HTTP 429 cuando se supera el límite de solicitudes sync por usuario. Push también puede devolver HTTP 413 si se excede el límite de cuerpo de 256 KiB. Los cuerpos de error siguen el formato compartido descrito arriba; los errores de validación y tamaño no garantizan un `code` específico de la ruta. Los fallos de negocio u operación de push se representan en el arreglo `results` de la respuesta push (HTTP 201 en la implementación actual), no como errores HTTP individuales por operación. El controller documenta HTTP 400, 401 y 429 para pull, y HTTP 400, 401, 413 y 429 para push.

## Logística

Todas las rutas `/logistics` exigen autenticación. El rol `carrier` gestiona su perfil, crea y opera **sus** viajes, registra check-ins y abre incidencias. El rol `operator` consulta transportistas y todos los viajes, detecta conflictos y reasigna; también puede cancelar viajes y resolver incidencias. Otros roles reciben HTTP 403.

| Método y ruta                             | Rol                   | Resultado                                                                                                                                    |
| ----------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /logistics/carrier-profile`         | `carrier`             | 201. Cuerpo `{ vehicleType, capacityKg, plate }`; crea o actualiza el perfil propio.                                                         |
| `GET /logistics/carrier-profile`          | `carrier`             | 200. Perfil propio.                                                                                                                          |
| `GET /logistics/carriers?limit=`          | `operator`            | 200. Lista de transportistas (1–200, por defecto 50).                                                                                        |
| `GET /logistics/orders/candidates?limit=` | `carrier`, `operator` | 200. Pedidos pagados con zonas, cantidades, unidades y lot IDs; omite dirección completa, comprador, proveedor y precios.                    |
| `POST /logistics/trips/recommend?limit=`  | `carrier`, `operator` | 200. `[{ orderId, kind, sequence, zone }]`. Recogidas antes que entregas, agrupadas por zona textual; sin coordenadas ni distancias.         |
| `POST /logistics/trips`                   | `carrier`             | 201. Cuerpo `{ id: "<UUID v7>", orderIds: ["<UUID>", ...] }` (1–20 IDs únicos). Requiere perfil de transportista y pedidos en estado `paid`. |
| `GET /logistics/trips/mine?limit=`        | `carrier`             | 200. Viajes propios.                                                                                                                         |
| `GET /logistics/trips?limit=`             | `operator`            | 200. Todos los viajes.                                                                                                                       |
| `GET /logistics/trips/:id`                | `carrier`, `operator` | 200. Detalle del viaje; el transportista solo ve los suyos.                                                                                  |
| `GET /logistics/trips/:id/stops`          | `carrier`, `operator` | 200. Paradas `{ id, tripId, orderId, kind, sequence, zone, scheduledAt, completedAt }`.                                                      |
| `POST /logistics/trips/:id/assign`        | `carrier`             | 200. `{ expectedVersion }`. Confirma la asignación; si ya está asignado al mismo transportista, no cambia nada.                              |
| `POST /logistics/trips/:id/reassign`      | `operator`            | 200. `{ expectedVersion, carrierId }`. Reasigna para resolver conflictos.                                                                    |
| `POST /logistics/trips/:id/start`         | `carrier`             | 200. `{ expectedVersion }`. Pasa a `in_progress`.                                                                                            |
| `POST /logistics/trips/:id/complete`      | `carrier`             | 200. `{ expectedVersion }`. Pasa a `completed`.                                                                                              |
| `POST /logistics/trips/:id/cancel`        | `carrier`, `operator` | 200. `{ expectedVersion, reason }`. Pasa a `cancelled`.                                                                                      |
| `GET /logistics/conflicts`                | `operator`            | 200. `{ orderIds: [...] }` con pedidos presentes en más de un viaje activo.                                                                  |
| `POST /logistics/stops/:id/checkins`      | `carrier`             | 201. Cuerpo `{ id, kind, clientAt, mediaRef?, baseVersion? }`. Devuelve el check-in persistido con `serverAt`.                               |
| `POST /logistics/incidents`               | `carrier`, `operator` | 201. `{ id, orderId, tripId?, type, description }`. Abre una incidencia.                                                                     |
| `POST /logistics/incidents/:id/resolve`   | `carrier`, `operator` | 200. Resuelve la incidencia.                                                                                                                 |
| `GET /logistics/incidents?limit=`         | `carrier`, `operator` | 200. Operador ve todas; transportista solo las vinculadas a sus viajes (1–200, por defecto 50).                                              |

Un viaje nace `planned` y, al crearlo desde pedidos `paid`, queda `assigned` en versión 2; cada pedido genera una parada `pickup` y una `delivery`, y pasa a `pickup_scheduled`. Las transiciones válidas son `planned → assigned → in_progress → completed`, más `cancelled` desde los estados activos. Todas las mutaciones de viaje usan `expectedVersion`: una versión desactualizada devuelve HTTP 409 con `code: "version_conflict"`.

El check-in cierra la parada y mueve el pedido con la versión **vigente** de `ordering`: `pickup → in_transit` y `delivery → delivered`. `baseVersion`, si se envía por HTTP, debe coincidir con la versión actual del viaje; un check-in repetido o una parada ya completada devuelve HTTP 400 con `code: "invalid_transition"`. El check-in escribe eventos `PickupConfirmed`/`DeliveryConfirmed` y cambios `checkin` en sync; cuando todas las paradas se completan, el viaje pasa a `completed` automáticamente. El mismo caso de uso se usa desde `/sync/push` con `entity: "checkin"`, donde `baseVersion` es obligatorio.

Ninguna solicitud ni respuesta de logística contiene latitud o longitud: la ubicación se representa como `zone` de texto y `mediaRef` es solo una referencia opcional a evidencia, no una carga de archivos. La decisión está en [ADR-013](adr/ADR-013.md).

El cliente móvil puede encolar el perfil (`carrier_profile`, `create`/`update`), la creación de viaje (`trip`, `create` con `orderIds`), el inicio (`trip`, `transition` con `payload.action: "start"` y `baseVersion`), check-ins (`checkin`, `create`) e incidencias (`incident`, `create` con `tripId` y `orderId`). Los handlers invocan los mismos servicios de logística que HTTP, por lo que se mantienen las verificaciones de rol, propiedad, estado y versión.

La lectura de candidatos para logística devuelve únicamente `orderId`, `status`, `version`, ventana de entrega, zona de entrega, zonas de recogida y líneas con `lotId`, cantidad y unidad. No devuelve nombre/teléfono del comprador, IDs de comprador/proveedor, precio ni dirección de entrega completa. Un transportista solo puede abrir una incidencia asociada a un viaje propio y a un pedido que tenga paradas en ese viaje; tampoco puede consultar ni resolver incidencias de otro transportista. El operador conserva lectura global y capacidad de resolución.

## IDs and idempotency

- Lot creation validates that its client-supplied ID is UUID v7. Category and product creation also accept a client-supplied ID, but their schemas validate UUID format without enforcing version 7. Do not infer uniform UUID v7 enforcement across create endpoints.
- No general HTTP idempotency-key contract is currently implemented. The Telegram update handler deduplicates processed updates by Telegram `updateId`; this is specific to Telegram webhook processing, not a client API idempotency guarantee.

## Rate limits

Rate limits are configurable; the following are the current default settings:

| Surface            | Default limit                                                         | Behavior                                                                                                                                                                  |
| ------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Catalog lot search | 60 requests per authenticated user per 60-second window               | In-memory limiter; excess requests return 429 and `Retry-After`.                                                                                                          |
| Telegram webhook   | 20 updates per sender and 300 globally per 60-second window           | In-memory limiter; excess updates are dropped without a reply, while the webhook acknowledges the update with HTTP 200. Sender identifiers are HMAC-keyed in the limiter. |
| OTP requests       | 3 per phone per 600-second window; 1 per phone per 60-second cooldown | Additional request limits are 30 per IP for OTP requests and 60 per IP for OTP verification, each per 600 seconds. These limits are configurable.                         |

These defaults are not a guarantee of globally coordinated limits across multiple API instances: the catalog and Telegram limiters are in-memory. The OTP counters use the database-backed identity rate-limit repository.

## Location privacy

Lot search accepts `lat`, `lng`, and `radiusKm` together. Coordinates outside Colombia are rejected when both `lat` and `lng` are supplied. In lot responses, exact lot coordinates and `providerId` are included only for the lot's provider. Other viewers may receive a rounded `distanceKm` when search computed one; this is not an exact location. The search radius is subject to the server-configured maximum. These response rules are specifically enforced by catalog lot serialization and should not be assumed for unrelated endpoints.

## Lot photos

All photo-management routes require authentication and the `producer` or `supplier` role. The caller must own the lot. Photo reads are included in lot responses as `photos: [{ id, position, url }]`; search/list responses include at most the first ready photo, while lot detail includes all ready photos. There are no separate `mediaRef` or `objectKey` response fields.

| Method and path                            | Purpose                                           | Request / result                                                                                                                                                                                                                                  |
| ------------------------------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /lots/{id}/photos`                   | Reserve a photo and prepare a direct upload       | Body: `{ "photoId": "<UUID v7>" }`. Returns `state: "pending"` and `uploadPolicy: { url, fields, expiresAt }`; send the file to the returned URL using the returned POST fields. A retry may return `processing` or `ready` without a new policy. |
| `POST /lots/{id}/photos/{photoId}/confirm` | Validate/process the uploaded image               | No body. Returns `pending`/`processing`/`ready` state. A ready result means the processed photo is available in lot reads.                                                                                                                        |
| `DELETE /lots/{id}/photos/{photoId}`       | Soft-delete the photo and request object deletion | No body; returns `{ "status": "deleted" }`.                                                                                                                                                                                                       |
| `PATCH /lots/{id}/photos/order`            | Set the complete order of ready photos            | Body: `{ "photoIds": ["<photo UUID>", ...] }`; returns `{ "status": "ordered" }`.                                                                                                                                                                 |

Upload policies are size-limited and expire; supported input formats are JPEG, PNG, and WebP, and processed output is always WebP. Photo counts, byte/pixel/dimension limits, expiries, processing lease, and upload rate limits are configurable; see [README](../README.md#lot-photos). Presigned URLs and object keys are sensitive temporary access material. The upload key is necessarily returned as `fields.key`, and the random processed-object key is embedded in the presigned download URL; clients must not log or persist these URLs beyond their intended use. Responses do not expose independent media-reference/object-key properties. Exact lot coordinates and `providerId` are not exposed to third-party viewers; those fields are included only for the lot's provider, as described above. Do not infer privacy behavior for unrelated endpoints.
