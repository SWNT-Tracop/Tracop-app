# AGENTS.md — TRACOP

> Guía para agentes de código (y humanos) que trabajen en este repositorio.
> Léela completa antes de escribir código. Si algo aquí contradice una petición, **pregunta** antes de improvisar.
> Idioma: este documento y la UI están en español (Colombia); el **código, commits e identificadores van en inglés**.

---

## 1. Qué es TRACOP

TRACOP es una plataforma móvil de abastecimiento agropecuario que conecta **productores**, **transportistas** y **compradores** (restaurantes y pequeños comercios). Centraliza una oferta hoy dispersa (WhatsApp, redes sociales, intermediarios) y permite **descubrir, comparar, comprar y dar seguimiento** a productos del campo con información suficiente para confiar en la transacción.

**Propuesta de valor en una frase:** conectar la oferta agropecuaria con quienes la necesitan, haciendo que encontrar, comparar y comprar productos del campo sea tan sencillo como debería ser.

**Diferenciación:** marketplace agro + información estructurada + descubrimiento/matching + confianza + abastecimiento recurrente.

### Principios de producto (guían cualquier decisión de diseño)

1. **Offline-first.** La conectividad del campo es escasa e inestable. Toda función del productor y del transportista debe funcionar sin conexión y sincronizar después.
2. **Simple para la persona común.** Pocas pantallas, textos cortos, íconos claros, cero jerga. Si un flujo necesita más de 3 toques para algo frecuente, rediséñalo.
3. **Canal donde ya está el usuario.** El productor puede publicar por mensajería (Telegram en la demo, WhatsApp después) sin instalar la app.
4. **IA que ahorra trabajo, no que decide.** La IA rellena formularios largos y sugiere precios; **el usuario siempre confirma**.
5. **Confianza visible.** Reputación, verificación y trazabilidad de eventos.

---

## 2. Alcance del piloto

**Zona:** compradores en Bogotá; abastecimiento (recogida en campo) desde Cundinamarca y Boyacá.
**Estrategia:** un corredor único, pocos productos, **intermediar sin comprar inventario**.
**Logística:** TRACOP organiza y coordina los camiones que mueven los lotes.
**Ingresos del piloto:** comisión por transacción + flete.

### Dentro del piloto (MVP)

- Registro y perfiles por rol; verificación manual de proveedores.
- Publicación de lotes (app offline y bot de mensajería) con asistente de IA.
- Descubrimiento: búsqueda, filtros (categoría, ubicación, precio, disponibilidad) y comparación.
- Pedidos y cotizaciones con seguimiento de estados.
- Logística asistida por operador: agrupar lotes, asignar camión, check-ins de recogida/entrega.
- Pagos con conciliación manual (transferencia / Nequi / contra entrega) y liquidación.
- Notificaciones por mensajería, push y SMS (respaldo).
- Backoffice para el operador.
- Reputación básica (calificaciones tras entrega).

### Fuera del piloto (no implementar sin aprobación explícita)

- Blockchain (ver ADR-003). Sí se implementa un **registro de eventos con hash encadenado**.
- Pasarela de pagos / escrow automático.
- Suscripciones, productos destacados, herramientas premium, servicios financieros.
- Optimización de rutas por algoritmo, ML de precios, múltiples corredores.
- Microservicios.

---

## 3. Actores y roles

| Rol (`role`) | Descripción                                                                    | Canal principal  |
| ------------ | ------------------------------------------------------------------------------ | ---------------- |
| `producer`   | Campesino/productor. Conectividad escasa, poca experiencia digital.            | App offline, bot |
| `supplier`   | Comercio/acopiador/cooperativa con inventario y volumen.                       | App, bot         |
| `buyer`      | Comprador profesional (restaurante, tienda). Busca comparar y repetir pedidos. | App              |
| `carrier`    | Transportista. Recogidas y entregas, a menudo sin señal.                       | App offline      |
| `operator`   | Equipo TRACOP: coordina logística, verifica, da soporte.                       | Backoffice       |
| `finance`    | Concilia pagos y liquida.                                                      | Backoffice       |
| `admin`      | Parámetros, usuarios, auditoría.                                               | Backoffice       |

**Sistemas externos:** Telegram Bot API (demo), WhatsApp Business Cloud API (futuro), proveedor LLM, servicio de mapas, FCM (push), proveedor SMS, fuente de precios de referencia, almacenamiento de objetos.

---

## 4. Glosario (término de negocio → identificador en código)

| Español                     | Código                 |
| --------------------------- | ---------------------- |
| Lote                        | `Lot`                  |
| Producto / categoría        | `Product` / `Category` |
| Pedido                      | `Order`                |
| Cotización                  | `Quote`                |
| Recogida / entrega          | `Pickup` / `Delivery`  |
| Viaje / ruta                | `Trip` / `Route`       |
| Comisión                    | `Commission`           |
| Flete                       | `Freight`              |
| Liquidación                 | `Settlement`           |
| Asiento contable            | `LedgerEntry`          |
| Reputación                  | `Reputation`           |
| Verificación                | `Verification`         |
| Incidencia                  | `Incident`             |
| Operación de sincronización | `SyncOperation`        |

---

## 5. Reglas innegociables

### Arquitectura

1. **Monolito modular con arquitectura hexagonal** (puertos y adaptadores). Ver §8.
2. **Regla de dependencia:** `domain` no importa nada de `application`, `adapters` ni de frameworks. `application` solo importa `domain` y `ports`. Los `adapters` implementan puertos.
3. **Un módulo, un dueño de datos.** Solo los módulos con datos propios definidos en §11 tienen schema de PostgreSQL; `messaging` no crea schema de negocio (solo `processed_updates`, dato técnico). **Prohibido** hacer joins o consultas directas a tablas de otro módulo. Se comunican por **interfaz pública del módulo** o por **eventos de dominio**.
4. **Los puertos se crean solo donde algo realmente va a variar** (mensajería, notificaciones, pagos, IA, precios, almacenamiento). No inventes puertos por costumbre.
5. **Todo canal de entrada normaliza a `InboundMessage`** antes de llegar a la capa de aplicación. La lógica de negocio nunca sabe si el mensaje vino de Telegram o WhatsApp.

### Datos

6. **Dinero siempre como entero** en pesos colombianos (`bigint`, sin decimales). Nunca `float`.
7. **IDs UUID v7 generados en el cliente** para entidades creadas offline.
8. **Fechas en UTC** (`timestamptz`); se muestran en `America/Bogota`.
9. **Todo cambio de estado de pedido, pago y lote genera un evento de dominio** persistido (outbox).
10. **Borrado lógico** (`deleted_at`) para entidades de negocio; los asientos contables y eventos son **inmutables**.

### Offline y sincronización

11. Toda mutación del cliente pasa por la **cola de operaciones (outbox local)** con `opId` idempotente. Nunca se llama al API directamente desde un componente de UI para mutar.
12. **Los pagos no se ejecutan offline.** Solo se guardan intención y comprobante, y se sincronizan.
13. La disponibilidad/inventario offline es **provisional**: el servidor confirma o rechaza al sincronizar y el cliente debe manejar ambos casos.

### IA

14. **La IA nunca ejecuta acciones por sí sola.** Produce un borrador estructurado que el usuario confirma.
15. Todo texto del usuario enviado a la IA es **no confiable** (riesgo de prompt injection). La salida se valida con esquema (`zod`) antes de usarse.
16. El proveedor de IA vive detrás de `LLMPort`; el modelo se configura por variable de entorno, nunca hardcodeado.

### Seguridad

17. Sin secretos en el repo. Sin `console.log` de datos personales.
18. Toda ruta del API exige autenticación y autorización por rol, salvo las explícitamente públicas.
19. Los webhooks verifican firma/secreto antes de procesar.
20. Toda acción sensible del backoffice queda en el **audit log**.

---

## 6. Stack tecnológico

| Capa                       | Tecnología                                                                                                |
| -------------------------- | --------------------------------------------------------------------------------------------------------- |
| Lenguaje                   | TypeScript (strict) en todo el repo                                                                       |
| Monorepo                   | pnpm workspaces + Turborepo                                                                               |
| Backend                    | Node.js 22 LTS + NestJS (módulos)                                                                         |
| Base de datos              | PostgreSQL 16 (schema por módulo)                                                                         |
| ORM / migraciones          | Drizzle ORM; migraciones SQL escritas a mano (`drizzle/migrate.ts`)                                       |
| Jobs / colas               | pg-boss (sobre PostgreSQL, sin Redis en el piloto)                                                        |
| Eventos internos           | `@nestjs/event-emitter` + tabla `outbox_events`                                                           |
| Validación / contratos     | zod (paquete compartido `contracts`) + OpenAPI generado                                                   |
| Autenticación / tokens     | `jose` (JWT HS256 firmado en servidor) detrás de `TokenServicePort`; OTP con HMAC-SHA256                  |
| Móvil                      | React Native + Expo (expo-router), TypeScript                                                             |
| BD local móvil             | expo-sqlite + outbox propio de sincronización                                                             |
| Backoffice                 | React + Vite + TypeScript, TanStack Query, Tailwind                                                       |
| Bot de mensajería          | grammY (Telegram, webhook). WhatsApp Cloud API después                                                    |
| IA                         | Anthropic o Google Gemini tras `LLMPort` (`LLM_PROVIDER`), salida estructurada validada                   |
| Almacenamiento de archivos | S3-compatible (Supabase Storage / MinIO en local)                                                         |
| Push / SMS                 | FCM / proveedor SMS tras `NotificationPort`                                                               |
| Logging                    | pino (JSON); OpenTelemetry cuando haya despliegue real                                                    |
| Contenedores               | Docker + docker-compose para desarrollo                                                                   |
| CI                         | GitHub Actions                                                                                            |
| Tests                      | Vitest (dominio, paquetes, backoffice), Jest (API, móvil), Testcontainers, supertest, Maestro (E2E móvil) |
| Lint / formato             | ESLint + Prettier + `eslint-plugin-boundaries` (impone la regla de dependencia)                           |

---

## 7. Estructura del repositorio

```
tracop/
├── AGENTS.md
├── README.md
├── package.json
├── pnpm-workspace.yaml
├── turbo.json
├── docker-compose.yml            # postgres, minio
├── .env.example
├── .github/workflows/            # ci.yml
├── docs/
│   ├── ARCHITECTURE.md
│   ├── GLOSSARY.md
│   ├── adr/                      # ADR-001 ... (decisiones)
│   └── diagrams/
├── packages/
│   ├── contracts/                # esquemas zod, DTOs, tipos de eventos (compartido)
│   └── config/                   # tsconfig, eslint, prettier base
└── apps/
    ├── api/
    │   ├── src/
    │   │   ├── main.ts
    │   │   ├── bootstrap/        # composition root: conecta puertos con adaptadores
│   │   ├── shared/
│   │   │   ├── kernel/       # Result, errores, Clock, ids
│   │   │   └── infra/        # configuración, BD, outbox, logging, HTTP
    │   │   └── modules/
    │   │       ├── identity/
    │   │       ├── catalog/
    │   │       ├── ordering/
    │   │       ├── logistics/
    │   │       ├── payments/
    │   │       ├── notifications/
    │   │       ├── messaging/
    │   │       ├── ai-assistant/
    │   │       ├── trust/
    │   │       ├── sync/
    │   │       └── backoffice/
    │   ├── drizzle/              # migraciones SQL
    │   └── test/                 # e2e y de integración
    ├── mobile/
    │   ├── app/                  # rutas (expo-router)
    │   └── src/
    │       ├── features/         # una carpeta por flujo (publicar-lote, pedidos...)
    │       ├── data/             # db local, outbox, motor de sync, repositorios
    │       ├── ui/               # componentes y tema
    │       └── i18n/
    └── backoffice/
        └── src/
            ├── features/
            ├── components/
            └── api/
```

### Estructura interna de cada módulo del API

```
modules/<modulo>/
├── domain/              # entidades, value objects, reglas, eventos. Sin dependencias externas
├── application/         # casos de uso (commands/queries), DTOs internos
├── ports/               # interfaces que el módulo necesita o expone
├── adapters/
│   ├── in/              # controllers HTTP, handlers de webhook, listeners de eventos
│   └── out/             # repositorios Drizzle, clientes externos
├── <modulo>.module.ts   # wiring de NestJS
├── index.ts             # ÚNICA superficie pública del módulo
└── __tests__/
```

> Otros módulos solo pueden importar desde `modules/<modulo>/index.ts`. Importar rutas internas es un error de lint.

---

## 8. Arquitectura por capas

```
CANALES      App móvil (offline) · Bot de mensajería · Backoffice web
   │
ADAPTADORES  API REST · Webhooks (Telegram/WhatsApp) · Endpoint de sync
DE ENTRADA
   │
APLICACIÓN   Casos de uso: PublishLot, CreateOrder, AssignTruck, VerifyPayment...
   │
DOMINIO      Entidades y reglas: Lot, Order, Commission, Reputation · eventos
   │
PUERTOS      MessagingPort · NotificationPort · PaymentPort · LLMPort
             PriceReferencePort · StoragePort · MapsPort · Clock · EventBus
   │
ADAPTADORES  TelegramAdapter (demo) → WhatsAppAdapter · FcmAdapter · SmsAdapter
DE SALIDA    ManualTransferAdapter → pasarela · AnthropicLLMAdapter · GeminiLLMAdapter · Drizzle repos
```

### Puertos principales

| Puerto               | Responsabilidad                                           | Adaptadores                                                                                          |
| -------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `MessagingPort`      | Enviar/recibir mensajes, botones, audio, fotos, ubicación | `TelegramAdapter` (ahora), `WhatsAppAdapter` (después), `InMemoryMessagingAdapter` (tests)           |
| `NotificationPort`   | Entregar una notificación por un canal                    | `MessagingNotifier`, `FcmAdapter`, `SmsAdapter`, `EmailAdapter`                                      |
| `PaymentPort`        | Registrar/verificar pagos                                 | `ManualTransferAdapter` (piloto), pasarela (futuro)                                                  |
| `LLMPort`            | Extraer datos estructurados de texto/audio/foto           | `AnthropicLLMAdapter`, `GeminiLLMAdapter` ([ADR-023](docs/adr/ADR-023.md)), `FakeLLMAdapter` (tests) |
| `PriceReferencePort` | Precios de referencia de mercado                          | adaptador de fuente de datos, `StaticPriceAdapter`                                                   |
| `StoragePort`        | Guardar fotos y comprobantes                              | `S3StorageAdapter`, `InMemoryStorageAdapter` (tests); en `shared/`, vía `StorageModule`              |
| `MapsPort`           | Distancias y geocodificación                              | adaptador de mapas, `FakeMapsAdapter`                                                                |

### `InboundMessage` (formato normalizado)

```ts
type InboundMessage = {
  channel: 'telegram' | 'whatsapp' | 'app';
  channelUserId: string; // chat_id o número
  userId?: string; // si el canal ya está vinculado
  type: 'text' | 'voice' | 'photo' | 'location' | 'contact' | 'action';
  text?: string;
  mediaRef?: string;
  location?: { lat: number; lng: number };
  action?: { name: string; payload: Record<string, unknown> }; // botones
  receivedAt: string; // ISO UTC
};
```

---

## 9. Módulos

| Módulo            | Responsabilidad                                                                                                                                              | Publica eventos                                                                                                                                                                                                         | Offline                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `identity`        | Registro, perfiles, roles (el admin cambia roles del mercado y suspende cuentas), vinculación de canales, OTP, sesiones                                      | `UserRegistered`, `UserVerified`, `UserRoleChanged`, `UserSuspended`, `UserReactivated`, `SessionRevoked`, `ChannelLinked`                                                                                              | Parcial                                       |
| `catalog`         | Productos, categorías, propuestas de producto, lotes, reservas de stock, fotos, búsqueda                                                                     | `LotPublished`, `LotReserved`, `LotAvailabilityRestored`, `LotSoldOut`, `LotExpired`, `LotCancelled`, `LotDeleted`, `ProductProposed`, `ProductApproved`, `ProductRejected`                                             | Sí                                            |
| `ordering`        | Pedidos, cotizaciones, reservas al aceptar, estados                                                                                                          | `OrderRequested`, `OrderQuoted`, `OrderAccepted`, `OrderCancelled`, `OrderPaymentPending`, `OrderPaid`, `OrderPickupScheduled`, `OrderInTransit`, `OrderDelivered`, `OrderDisputed`, `OrderClosed`                      | No (solo en línea)                            |
| `logistics`       | Perfiles de transportista, viajes por pedido, paradas, check-ins, incidencias                                                                                | `TripPlanned`, `TripAssigned`, `TripStarted`, `TripCompleted`, `TripCancelled`, `PickupConfirmed`, `DeliveryConfirmed`, `IncidentOpened`, `IncidentResolved`                                                            | Sí (viajes, check-ins e incidencias por sync) |
| `payments`        | Medio de pago, comprobantes, verificación, disputas, ledger y liquidaciones                                                                                  | `PaymentInitiated`, `PaymentProofUploaded`, `PaymentVerified`, `PaymentRejected`, `PaymentHeld`, `PaymentDisputed`, `PaymentDisputeReleased`, `PaymentRefunded`, `PaymentSettled`, `SettlementIssued`, `SettlementPaid` | No                                            |
| `notifications`   | Bandeja, preferencias, enrutamiento por canal, reintentos y estado de envío                                                                                  | — (consume eventos de otros módulos)                                                                                                                                                                                    | Bandeja por sync                              |
| `messaging`       | Webhooks y adaptadores de canal, normalización a `InboundMessage`, flujos conversacionales                                                                   | —                                                                                                                                                                                                                       | No                                            |
| `ai-assistant`    | Borradores de lote desde texto por Telegram (extracción con IA, confirmación con botones), consentimiento de IA vía identity; sugerencia de precios (fase 8) | — (el lote confirmado lo publica catalog: `LotPublished`)                                                                                                                                                               | No                                            |
| `recommendations` | Precios de referencia (DANE-SIPSA, importación manual), sugerencia de precios, recomendaciones de lotes y alertas de precio                                  | `PriceAlertMatched`                                                                                                                                                                                                     | No                                            |
| `trust`           | Calificaciones, reputación, verificación manual de proveedores, métricas internas de entrega por transportista                                               | `RatingSubmitted`, `ProviderVerified`, `VerificationRequested`, `VerificationRejected`, `VerificationRevoked`, `RatingCommentHidden`                                                                                    | Lectura                                       |
| `sync`            | Recepción idempotente de operaciones, cursores de pull, resolución de conflictos                                                                             | — (no emite eventos)                                                                                                                                                                                                    | Núcleo offline                                |
| `backoffice`      | Audit log, parámetros de negocio editables y métricas operativas                                                                                             | —                                                                                                                                                                                                                       | No                                            |

**Regla:** si un módulo necesita datos de otro, usa su `index.ts` (consulta pública) o reacciona a su evento. Nunca su tabla.

Los eventos se escriben en `shared.outbox_events` en la misma transacción que el cambio; el despachador del trabajador los entrega a los consumidores registrados ([ADR-016](docs/adr/ADR-016.md)). Consumidores: `payments.hold-on-delivery` (`OrderDelivered` retiene el pago), `notifications.dispatch` (avisos, ver §14 y [ADR-018](docs/adr/ADR-018.md)), `trust.delivery-stats`, `recommendations.price-observations` (`OrderAccepted`, `OrderDelivered`) y `recommendations.lot-alerts` (`LotPublished` → `PriceAlertMatched`, [ADR-022](docs/adr/ADR-022.md)).

---

## 10. Offline-first y sincronización

### Modelo

- El cliente móvil es un **cliente grueso**: la interfaz lee los datos desde SQLite local. La outbox del cliente es la ruta prevista para las escrituras, pero el protocolo del servidor no define su esquema local ni la implementación de persistencia.
- **Entidades sincronizadas:** pull entrega `category`, `product`, `lot`, `trip`, `checkin`, `incident` y `notification`; push acepta `lot`, `trip` (`create`; `transition` solo `start`), `checkin` (`create`), `incident` (`create`) y `carrier_profile` (`create`/`update`). Pedidos y pagos no se sincronizan (solo en línea).

### Protocolo de sincronización implementado

La API autenticada acepta `POST /sync/push` con entre 1 y 50 operaciones estrictas:

```ts
type SyncOperation = {
  opId: string; // UUID v7; clave de idempotencia
  entity: string; // 1–64 caracteres; con manejador de push: lot, trip, checkin, incident, carrier_profile
  entityId: string; // UUID
  type: 'create' | 'update' | 'transition' | 'delete';
  payload: Record<string, unknown>;
  baseVersion?: number; // entero positivo, requerido para operaciones de lot que no sean create
};
```

- `deviceId` se obtiene de la sesión autenticada; la operación no lo envía. El contrato de la API no incluye un campo `clientTs`.
- Las operaciones se procesan en el orden de la solicitud. Si se repite un `opId` con el mismo usuario y el mismo hash canónico del payload, se reproduce el resultado anterior; reutilizarlo con otro payload o entre usuarios distintos se rechaza. Una operación fallida bloquea las operaciones posteriores de la misma combinación `entity:entityId` en ese lote de push, pero no las de entidades independientes.
- Las operaciones `update`, `transition` y `delete` de `lot` usan concurrencia optimista: el `baseVersion` de cada operación debe coincidir con la versión actual del servidor. Para una secuencia de cambios sobre un lote, se usa el `serverVersion` más reciente devuelto por cada operación exitosa como `baseVersion` de la siguiente. Si hay conflicto, se devuelve la versión del servidor cuando esté disponible. `create` no lleva `baseVersion`.
- El actor debe ser dueño del lote: push requiere autenticación y delega en casos de uso del catálogo que verifican la propiedad. En `create`, el `id` del payload debe ser igual a `entityId`.
- `GET /sync/pull?cursor=<server_seq>&limit=<1..500>` requiere autenticación y usa por defecto `cursor` `0` y `limit` `200`. El cursor es una secuencia entera del servidor, no una marca de tiempo del cliente. Pull devuelve filas con `server_seq > cursor`, en orden ascendente, cuyo `owner_user_id IS NULL` o coincide con el usuario autenticado. Incluye los cambios del dispositivo solicitante; los clientes aplican un cambio solo cuando la versión de su entidad es más reciente que la versión local.
- `nextCursor` corresponde a la última secuencia devuelta si hay otra página; de lo contrario, avanza hasta el horizonte de secuencia global actual, incluso sobre filas filtradas por propiedad. Se debe guardar el cursor devuelto. `hasMore` indica si hay una página adicional.
- Las respuestas distinguen `applied`, `rejected` y `conflict`. Los resultados de operaciones pueden incluir `code` y `serverVersion`; los cambios de pull contienen `serverSeq`, `entity`, `entityId`, `op`, `payload` y `occurredAt`.
- Los borrados de lotes son lógicos y publican un cambio `delete` con `payload.tombstone: true`; quienes consumen estos cambios deben conservar/aplicar la marca de borrado para evitar que los registros eliminados reaparezcan. La cancelación de un lote es un cambio `cancel`, no una marca de borrado.

### Política de conflictos por tipo de dato

| Dato                   | Política                                                                                                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entidades del catálogo | Pull se ordena por `server_seq`; los cambios restringidos por propiedad solo se devuelven a su dueño. Las escrituras de `lot` usan concurrencia optimista mediante `baseVersion`. |
| Otras entidades        | Actualmente no hay manejadores de push; no se debe interpretar la hoja de ruta general del producto como comportamiento vigente del protocolo.                                    |

### Reglas

- El límite de la solicitud push es de 50 operaciones; el tamaño máximo de una página pull es 500. Los reintentos/esperas progresivas y el comportamiento de la outbox local son responsabilidad del cliente y no están implementados en estos endpoints de la API.
- Una operación rechazada o en conflicto no bloquea entidades independientes, pero las operaciones posteriores de la misma entidad en ese lote se rechazan por depender de ella.
- La sincronización de fotos está fuera del endpoint de sync actual; no se debe asumir que la carga de archivos adjuntos forma parte de este protocolo.

---

## 11. Base de datos

PostgreSQL 16. **schema solo para módulos con datos propios.** Convenciones: `snake_case`, PK `id uuid` (v7), `created_at`, `updated_at`, `deleted_at` (nullable), `version int` donde aplique, montos `bigint` en COP, estados como `text` con `CHECK`.

### Tablas principales (por schema)

**identity**

- `users` (id, role, full_name, phone, status, locale, phone_verified_at, created_at, updated_at, deleted_at); `status` ∈ `pending_verification`, `active`, `suspended`, `expired`. Un registro sin verificar tras `UNVERIFIED_RETENTION_HOURS` (24, PROVISIONAL) pasa a `expired`: su teléfono se reemplaza por un HMAC (el número queda libre) y el nombre se borra; los consentimientos se conservan.
- `channel_links` (id, user_id, channel, channel_user_id, verified_at) — único por (`channel`, `channel_user_id`)
- `devices` (id, user_id, platform, push_token, last_seen_at, created_at) — único por dispositivo/usuario
- `otp_codes` (id, user_id, code_hash, purpose, attempts, max_attempts, expires_at, consumed_at, created_at)
- `sessions` (id, user_id, refresh_hash, device_id, family_id, expires_at, rotated_at, revoked_at, revoked_reason, last_used_at, created_at)
- `provider_profiles` (user_id, display_name, municipality, department, lat, lng, description)
- `consents` (id, user_id, policy_type, version, accepted_at, channel) — append-only, único por (`user_id`, `policy_type`, `version`)
- `ai_consent_events` (id, user_id, version, decision `accept`\|`withdraw`, channel, recorded_at) — append-only; el estado vigente es la última decisión para la versión `AI_CONSENT_VERSION` (Ley 1581)
- `rate_limit_counters` (key_hash, window_start, count) — key HMAC, nunca teléfono/IP en claro

**catalog**

- `categories` (id uuid, name text, parent_id uuid nullable, depth integer, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz nullable). `depth` está entre 1 y 3; nombre no vacío y máximo 100 caracteres.
- `products` (id uuid, category_id uuid, name text, search_text text, unit text, attributes jsonb, status text NOT NULL DEFAULT 'approved', proposed_by uuid nullable, reviewed_by uuid nullable, reviewed_at timestamptz nullable, rejection_reason text nullable, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz nullable). Nombre no vacío y máximo 120 caracteres; atributos es un objeto. `search_text` contiene el nombre normalizado para búsquedas. `status` ∈ `approved`, `pending_review`, `rejected`; `products_proposal_review_check` exige proponente y sin revisión en pendientes, ni proponente ni revisor en aprobados curados, y proponente, revisor y fecha en propuestas revisadas; `rejection_reason` obligatorio en rechazados. Índice único parcial (`category_id`, `search_text`) para `approved` y `pending_review` no eliminados (ver [ADR-015](docs/adr/ADR-015.md)).
- `lots` (id uuid, provider_id uuid, product_id uuid, quantity numeric(12,3), unit text, unit_price bigint, quality_grade text nullable, available_from timestamptz, available_until timestamptz, location_lat double precision, location_lng double precision, status text, version integer, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz nullable). La cantidad del dominio se representa como `quantityMilli: bigint` (milésimas) y se convierte a/desde `numeric(12,3)` al persistir. El precio unitario es entero positivo en COP; la unidad del lote debe coincidir con la del producto. Coordenadas se restringen a los límites de Colombia; `quality_grade` admite texto opcional de hasta 100 caracteres sin vocabulario cerrado.
- `lot_photos` (id uuid, lot_id uuid, media_ref text, created_at timestamptz NOT NULL, state text NOT NULL, content_type text nullable, size_bytes integer nullable, position integer NOT NULL, expires_at timestamptz NOT NULL, lease_token text nullable, lease_expires_at timestamptz nullable, deleted_at timestamptz nullable). `state` puede ser `pending`, `processing` o `ready`; las filas `ready` requieren `content_type = 'image/webp'` y `size_bytes` no nulo. Índices: `lot_id`, vencimiento para filas que no estén `ready` y `(lot_id, position)` para filas no eliminadas.
- `lot_reservations` (id uuid, lot_id uuid, order_id uuid, quantity_milli numeric(12,3) > 0, status text, expires_at timestamptz nullable ≥ created_at, created_at, updated_at). `status` ∈ `active`, `released`, `consumed`. Restan cantidad disponible las `consumed` y las `active` no vencidas; una `active` con `expires_at` nulo está retenida mientras se revisa un comprobante de pago y no vence.

Unidades actualmente aceptadas por el catálogo: `kg`, `g`, `lb`, `und`, `docena`, `arroba`, `quintal`, `caja`, `mano`, `bulto`. Esta lista es **provisional**; el vocabulario de unidades y el vocabulario para `quality_grade` siguen pendientes de decisión (§23).

**ordering**

- `orders` (id, buyer_id, provider_id, status, delivery_address, delivery_window, request_hash, created_at, updated_at, version, accepted_at, cancel_reason, deleted_at). `status` con CHECK de los 12 estados de §12. Un pedido tiene un solo proveedor.
- `order_lines` (id, order_id, lot_id, provider_id, quantity_milli numeric(12,3), unit_price numeric(20,0), unit)
- `quotes` (id, order_id, subtotal, freight, commission, total, provider_net — numeric(20,0) ≥ 0; valid_until, status, created_at, updated_at). `status` ∈ `active`, `accepted`, `expired`, `cancelled` y se persiste junto con el pedido.
- `order_events` (id, order_id, type, payload, actor_id, occurred_at, prev_hash, hash) — **append-only, hash encadenado**; `type` ∈ `OrderRequested`, `OrderQuoted`, `OrderAccepted`, `OrderCancelled`, `OrderPickupScheduled`, `OrderInTransit`, `OrderDelivered`.

**logistics**

- `carriers` (user_id, vehicle_type, capacity_kg > 0, plate, created_at, updated_at, deleted_at); placa única entre activos.
- `trips` (id, carrier_id, status, version, planned_at, route jsonb, created_at, updated_at, deleted_at); `status` ∈ `planned`, `assigned`, `in_progress`, `completed`, `cancelled`.
- `trip_stops` (id, trip_id, order_id, order_version, kind, sequence, zone, scheduled_at, completed_at); `kind` ∈ `pickup`, `delivery`; únicos (trip_id, sequence) y (trip_id, order_id, kind).
- `checkins` (id, stop_id, trip_id, order_id, carrier_id, kind, client_ts, media_ref, created_at); único (stop_id, kind). **Sin coordenadas** (ver [ADR-013](docs/adr/ADR-013.md)). Ninguna tabla de logistics guarda coordenadas ni direcciones: la ubicación exacta (solo para el transportista asignado y el personal) se lee en cada petición de catalog y ordering.
- `incidents` (id, order_id, trip_id, type, description, status, opened_at, closed_at, deleted_at); `status` ∈ `open`, `resolved`.

**payments**

- `payments` (id, order_id, buyer_id, provider_id, method, status, subtotal, freight, commission, total, provider_net — bigint COP con CHECK de consistencia; version, proof_incoming_key, proof_upload_expires_at, proof_key, proof_uploaded_at, reviewed_by, reviewed_at, rejection_reason, held_at, carrier_id, dispute_reason, created_at, updated_at). `method` ∈ `transfer`, `nequi`; `status` ∈ `pending`, `proof_uploaded`, `verified`, `held`, `settled`, `rejected`, `disputed`, `refunded`. Índice único parcial: un pago no rechazado por pedido.
- `payment_events` (id, payment_id, order_id, type, actor_id, payload, occurred_at) — **append-only** (trigger), una fila por transición.
- `ledger_transactions` (id, order_id, payment_id, kind, created_at) — único por (`order_id`, `kind`): idempotencia de cada asiento. `kind` ∈ `payment_verified`, `delivery_confirmed`, `settlement_paid_producer`, `settlement_paid_carrier`, `refund`.
- `ledger_entries` (id, transaction_id, order_id, account, debit, credit, created_at) — **inmutable** (trigger) y **balanceado por transacción** (trigger diferido al confirmar); una sola cara positiva por línea.
- `settlements` (id, payment_id, order_id, beneficiary_id, beneficiary_kind, amount > 0, status, issued_at, paid_at, paid_by, reference, version); único por (`payment_id`, `beneficiary_kind`); `status` ∈ `issued`, `paid`.
- `commission_rules` y `freight_rates` siguen planificadas: hoy la comisión y el flete salen de `ORDER_COMMISSION_RATE_BPS` y `ORDER_FREIGHT_COP`.

**notifications**

- `preferences` (user_id PK, channel_order jsonb, quiet_hours jsonb nullable, updated_at). Sin fila: mensajería → push → SMS y sin horario sin molestias.
- `inbox` (id, user_id, event_id, kind, title ≤120, body ≤500, template_version, created_at, read_at); único por (`event_id`, `user_id`): idempotencia del consumidor.
- `deliveries` (id, inbox_id, user_id, event_id, kind, channel, status, attempts, next_attempt_at, locked_until, lease_token, last_error ≤64, sent_at, created_at, updated_at); único por (`event_id`, `user_id`, `channel`). `channel` ∈ `messaging`, `push`, `sms`; `status` ∈ `pending`, `sent`, `failed`, `skipped`.
- Las plantillas viven en código (`domain/templates.ts`, versión `v1`); la tabla `templates` llegará con el backoffice.

**trust**

- `ratings` (id, order_id, rater_id, ratee_id, ratee_kind, score 1–5, comment ≤500 nullable, created_at, hidden_at, hidden_by); único por (`order_id`, `ratee_kind`); `ratee_kind` ∈ `provider`, `carrier`.
- `reputations` (subject_id, subject_kind, rating_sum bigint, ratings_count, updated_at); PK (`subject_id`, `subject_kind`); actualizado con upsert atómico, sin recontar.
- `carrier_delivery_stats` (carrier_id, delivered_count, with_window_count, on_time_count, updated_at) y `counted_deliveries` (order_id PK): métricas internas por transportista, una vez por pedido.
- `verifications` (provider_id PK, status, note ≤300, checks jsonb, reason ≤300, requested_at, reviewed_by, reviewed_at, version); `status` ∈ `unverified`, `pending`, `verified`, `rejected`, `revoked`. Sin documentos (§23.8).

**sync**

- `processed_operations` (`op_id uuid` PK, `device_id uuid` NOT NULL, `user_id uuid` NOT NULL, `entity text` NOT NULL, `entity_id uuid` NOT NULL, `result jsonb` NOT NULL, `error_code text` nullable, `payload_hash text` NOT NULL, `server_seq bigint` nullable, `processed_at timestamptz` NOT NULL). Restricciones: longitud de `entity` entre 1 y 64; longitud del código de error nullable ≤100; `payload_hash` contiene 64 caracteres hexadecimales en minúscula; `result` es un objeto JSON cuyo `status` es `applied`, `rejected` o `conflict`.
- `change_log` (`server_seq bigint` PK, default from `sync.change_log_server_seq_seq`; `entity text` NOT NULL; `entity_id uuid` NOT NULL; `op text` NOT NULL; `payload jsonb` NOT NULL; `owner_user_id uuid` nullable; `occurred_at timestamptz` NOT NULL). Índice: `(owner_user_id, server_seq)`. Restricciones: longitud de `entity` entre 1 y 64 y valor en `category`, `product`, `lot`, `trip`, `checkin`, `incident`, `notification`; longitud de `op` entre 1 y 32 y valor en `upsert`, `delete`, `cancel`; tamaño serializado de `payload` ≤262,144 bytes.

Actualmente no hay implementada retención ni compactación para `sync.change_log` ni `sync.processed_operations`: el diseño y por qué hoy rompería cursores o idempotencia están en [docs/SYNC-RETENTION.md](docs/SYNC-RETENTION.md); no se asume un periodo de retención.

**backoffice**

- `audit_log` (id, actor_id nullable, actor_role, action, entity, entity_id, before jsonb, after jsonb, at, ip_hash, request_id) — **append-only** (trigger). En lugar de la IP se guarda su HMAC-SHA256 (`RATE_LIMIT_HMAC_SECRET`); `before`/`after` solo con los campos que cambian, sin datos personales.
- `parameters` (key PK, value texto entero, updated_by, updated_at). Claves: `order.commission_rate_bps`, `order.freight_cop`, `order.quote_ttl_hours`, `order.reservation_ttl_hours`, `payment.claim_window_hours`, `payment.rejection_grace_hours`, `catalog.product_proposal_pending_limit`, `trust.rating_window_days`, `trust.min_ratings_visible`, `trust.comment_max_length`, `trust.verification_cooldown_days`. Sin fila rige la variable de entorno.

**shared**

- `outbox_events` (id, aggregate, type, payload jsonb, created_at, published_at, attempts, next_attempt_at, last_error, failed_at, locked_until, lease_token). `next_attempt_at` NULL significa «pendiente ya»; `failed_at` marca la cola de fallidos; `locked_until` y `lease_token` van juntos (lease del despachador).
- `outbox_deliveries` (consumer, event_id → outbox_events, delivered_at); PK (consumer, event_id): idempotencia por consumidor (ver [ADR-016](docs/adr/ADR-016.md)).
- `schema_migrations` (id, applied_at) — metadata técnica del runner de migraciones
- `worker_heartbeats` (worker_id PK `host:pid`, beat_at): latido de cada proceso del trabajador (trabajo `shared.worker-heartbeat`, cada minuto); `GET /ready` responde 503 si el más reciente supera `READY_WORKER_MAX_AGE_SECONDS`.

**ai_assistant**

- `lot_drafts` (id, short_code bigint único, user_id, status, version, fields jsonb, question, lot_id único, expires_at, created_at, updated_at); `status` ∈ `collecting`, `awaiting_confirmation`, `confirmed`, `saved_as_draft`, `cancelled`, `expired`; un activo por usuario (índice único parcial); los terminados no conservan campos (CHECK) y se purgan tras `AI_FINISHED_DRAFT_RETENTION_DAYS`.
- `inbox` (id, seq, channel, channel_user_id, payload jsonb, received_at, attempts, lease_token, lease_until, available_at) — mensajes pendientes del trabajador; la fila (con el texto) se borra al atenderse.
- `usage` (id, user_id, day, purpose, input_tokens, output_tokens, latency_ms, outcome, created_at) — sin contenido; se purga tras `AI_USAGE_RETENTION_DAYS`.
- `monthly_budget` (month PK, used_tokens, reserved_tokens) — tope mensual con reserva atómica.

**recommendations**

- `reference_imports` (id, source, file_sha256 único, rows_imported, imported_at) y `reference_prices` (id, source, market, source_product, presentation, price bigint, observed_on, imported_at, import_id); únicas por (source, market, source_product, presentation, observed_on).
- `product_source_mappings` (id, product_id, unit, source, source_product, presentation, created_by, created_at): asociación manual del personal, única por (source, source_product, presentation).
- `price_observations` (id, order_line_key hash único, product_id, unit, unit_price, provider_key HMAC, observed_at, delivered_at): sin ids de personas.
- `buyer_history` (buyer_id, product_id, orders_count, last_ordered_at) y `counted_orders` (order_id PK): historial propio de cada comprador, contado una vez por pedido.
- `price_alerts` (id, buyer_id, product_id, max_price, radius_km 1–300, center_lat/center_lng numeric(5,2) redondeados, created_at, deleted_at) y `alert_matches` (alert_id, lot_id) PK: un aviso por alerta y lote.

**messaging (datos técnicos de adaptador, no de negocio)**

- `processed_updates` (update_id bigint pk, received_at) — idempotencia de updates de Telegram; no es dato de negocio del módulo. Se purgan tras `PROCESSED_UPDATES_RETENTION_DAYS`.

### Reglas de base de datos

- Migraciones **solo hacia adelante**, escritas a mano en `apps/api/drizzle` y aplicadas con `drizzle/migrate.ts` (registra en `shared.schema_migrations`); nunca `drizzle-kit generate` ni editar una migración ya integrada. Numeración única y contigua (`pnpm db:check-migrations`).
- Índices obligatorios: FK, `lots(product_id, status)`, `lots` geoespacial si se usa búsqueda por cercanía, `change_log(server_seq)`.
- Integridad del ledger: restricción/trigger o prueba que verifique débitos = créditos por `transaction_id`.
- Datos personales (teléfono, documentos) con acceso restringido; ver §16.
- Consentimientos inmutables por versión de política; no editar ni borrar filas de `identity.consents`.
- Seeds de desarrollo en `apps/api/drizzle/seed/` con datos sintéticos, **nunca** datos reales.

---

## 12. Máquinas de estado

Las transiciones se validan en el **dominio**; un estado inválido lanza error de dominio, nunca se "corrige" en silencio.

**Lote:** `draft → published | cancelled` · `published → reserved | expired | cancelled` · `reserved → published | expired | cancelled`. Un lote pasa a `reserved` cuando las reservas activas agotan su cantidad y vuelve a `published` al liberarse una reserva (`LotAvailabilityRestored`); solo se borra (lógicamente) en `draft`. Pasa de `reserved` a `sold_out` (`LotSoldOut`) cuando pagos verificados consumen toda su cantidad; `sold_out` es terminal.

**Pedido:** `draft → requested → quoted → accepted → payment_pending → paid → pickup_scheduled → in_transit → delivered → closed`. Solo se cancela **antes del pago** (`draft`, `requested`, `quoted`, `accepted`, `payment_pending` `→ cancelled`); desde `paid` hasta `delivered` la única salida alternativa es `→ disputed → closed`. payments lleva el pedido a `payment_pending` (medio elegido), `paid` (comprobante verificado), `disputed` (disputa del comprador) y `closed` (liquidado o disputa resuelta).

**Cotización:** `active → accepted | expired | cancelled`. **Reserva de stock:** `active → released | consumed`; mientras se revisa un comprobante queda `active` sin vencimiento (retenida).

**Pago:** `pending → proof_uploaded → verified → held → settled` · `proof_uploaded → rejected` · `verified | held → disputed` · `disputed → held` (liberada, solo tras la entrega) `| refunded`. **Liquidación:** `issued → paid`.

**Viaje:** `planned → assigned → in_progress → completed`, y `planned | assigned | in_progress → cancelled`. Al crearlo, el viaje pasa de `planned` a `assigned` para su transportista en la misma operación.

---

## 13. Pagos y comisión

### Cálculo de la cotización

```
subtotal   = Σ (unit_price × quantity)
freight    = max(min_charge, rate_per_kg × peso_total)       // o tarifa fija por corredor en el piloto
commission = round(subtotal × rate_bps / 10_000)             // tasa parametrizable
total comprador = subtotal + freight
neto productor  = subtotal − commission                      // propuesta por defecto
```

> Quién asume la comisión y su porcentaje son **decisiones abiertas** (§23). La tasa y el flete son parámetros editables por `admin` (`order.commission_rate_bps`, `order.freight_cop`, ver [ADR-019](docs/adr/ADR-019.md)), con la variable de entorno como valor por defecto; hoy la comisión se descuenta al productor.

### Flujo del piloto

1. El comprador acepta la cotización → pago `pending`.
2. Paga por transferencia/Nequi/contra entrega y sube comprobante → `proof_uploaded`.
3. `finance`/`operator` verifica en el backoffice → `verified` (se registran asientos).
4. Se retiene hasta entrega confirmada + ventana de reclamo → `held`.
5. Se liquida a productor y transportista → `settled`.
6. Una disputa congela la liquidación del pedido.

### Asientos del ledger (ejemplo de pedido pagado y liquidado)

| Momento            | Débito                                 | Crédito                                                                      |
| ------------------ | -------------------------------------- | ---------------------------------------------------------------------------- |
| Pago verificado    | `cash_held` (subtotal+flete)           | `payable_buyer_funds`                                                        |
| Entrega confirmada | `payable_buyer_funds`                  | `payable_producer` (neto) · `payable_carrier` (flete) · `revenue_commission` |
| Liquidación pagada | `payable_producer` / `payable_carrier` | `cash_held`                                                                  |

### Reglas

- Operaciones de pago **idempotentes** (clave por pedido + tipo).
- `PaymentPort` es la única puerta a medios de pago; el dominio no conoce Nequi, PSE ni pasarelas.
- Toda acción del personal sobre pagos (verificar, rechazar, resolver disputa, pagar liquidación) escribe en `backoffice.audit_log` en la misma transacción ([ADR-019](docs/adr/ADR-019.md)); las transiciones de pago quedan además en `payments.payment_events`.

---

## 14. Notificaciones

**Flujo:** evento de dominio → `NotificationService` → preferencias del usuario → plantilla/idioma → canal → adaptador → registro en `deliveries`.

- **Prioridad de canal:** mensajería (Telegram/WhatsApp) → push → SMS (solo críticos) → correo (recibos a compradores).
- **Eventos con plantilla:** pedido nuevo, cotización, aceptación, recogida programada, en camino, entregado, pago verificado, liquidación, incidencia.
- **Reglas:** escalado a otro canal si no hay lectura/confirmación en N minutos; horario sin molestias (excepto críticos); agrupación en resumen; reintentos con espera creciente; deduplicación por (`event_id`, `user_id`, `channel`).
- **Interactivas:** botones de mensajería (confirmar/rechazar) vuelven como `InboundMessage` de tipo `action` y ejecutan el caso de uso correspondiente.
- **Offline:** la app muestra una bandeja (`inbox`) sincronizada; lo crítico además sale por mensajería/SMS.
- Costos: SMS y WhatsApp cuestan; usar el canal gratuito cuando sea posible.

**Implementado hoy** ([ADR-018](docs/adr/ADR-018.md)): consumidor `notifications.dispatch` para pedido aceptado, pago verificado o rechazado, recogida programada, en camino, entregado, liquidación emitida o pagada, incidencia y alerta de precio (`PriceAlertMatched` → `lot_alert`); mensajería por Telegram; push y SMS sin proveedor (`skipped`); horario sin molestias; reintentos con espera creciente (trabajo `notifications.send-due`); deduplicación por (`event_id`, `user_id`) y (`event_id`, `user_id`, `channel`); bandeja en `GET /me/inbox` y en sync. Pendientes: escalado por falta de lectura, resúmenes, correo, botones interactivos y la cotización (el pedido nace cotizado).

---

## 15. Mensajería y asistente de IA

### Canal (Telegram primero)

- Webhook de Telegram con **secret token** verificado en cabecera.
- Vinculación de identidad: botón de compartir contacto o código de vinculación → crea `channel_links`.
- El bot soporta texto, voz, fotos, ubicación y botones. Todo se normaliza a `InboundMessage`.
- Migrar a WhatsApp = escribir `WhatsAppAdapter` contra `MessagingPort` (+ plantillas aprobadas por Meta); **cero cambios en dominio/aplicación**.
- Todo adaptador debe pasar el **test de contrato de `MessagingPort`** (§17).

### Flujo de publicación asistida

1. El productor escribe su oferta por Telegram (solo texto; audio y foto responden «aún no disponible»).
2. Con consentimiento de IA vigente, `ai-assistant` pide al modelo los fragmentos (producto, cantidad, unidad, precio y si es por unidad o total, calidad, fechas); el código los convierte y pregunta **un dato a la vez** lo que falte o sea ambiguo. Sin consentimiento, con IA apagada, al superar un límite o si el modelo falla: formulario guiado sin IA.
3. Se muestra el **borrador** legible (municipio, nunca coordenadas) con Confirmar / Editar / Cancelar.
4. Solo al confirmar se crea y publica el lote por la API pública de catalog, en una transacción ([ADR-021](docs/adr/ADR-021.md)).

### Sugerencia de precios

- Implementada en `recommendations` ([ADR-022](docs/adr/ADR-022.md)): percentiles 25–75 de los precios de referencia DANE-SIPSA importados y, con al menos 3 observaciones de 2 proveedores, del histórico propio de TRACOP; con menos de 3 valores, `insufficient_data`. Siempre se presenta como **sugerencia con su fuente y fecha**, nunca como valor impuesto; el asistente la recibe por `PriceSuggestionPort`.
- ML queda para después de tener datos suficientes.

### Reglas de IA

- Prompts versionados en `modules/ai-assistant/prompts/`.
- Salida validada con zod; si falla, se pide aclaración al usuario (no se reintenta indefinidamente).
- Registrar costo/latencia por llamada. Sin datos personales innecesarios en los prompts.
- Evaluaciones: conjunto determinista en CI (100 %) y conjunto vivo de frases sintéticas con `pnpm ai:eval-live`, que corre una persona, nunca CI (objetivo ≥ 90 % de campos, PROVISIONAL).

---

## 16. Seguridad y privacidad

- **Autenticación:** teléfono + OTP entregado por el canal vinculado (o SMS); JWT de corta vida + refresh rotativo por dispositivo.
- **Autorización:** RBAC por rol + verificación de propiedad del recurso (un productor solo ve/edita lo suyo).
- **Datos personales:** cumplir la **Ley 1581 de 2012** (protección de datos personales, Colombia): consentimiento explícito, finalidad clara, derecho a consulta y supresión. Cifrar en reposo; minimizar lo que se envía a terceros (incluida la IA).
- **Consentimiento de privacidad:** cada usuario acepta una versión identificada del aviso; se persiste en `identity.consents` con tipo, versión, fecha y canal. La versión vigente viene de `PRIVACY_POLICY_VERSION`; el texto debe definirse por el equipo y no se inventa en código.
- **Webhooks:** verificar firma/secret; rechazar replays.
- **API:** rate limiting, validación de entrada con zod en cada borde, tamaño máximo de cargas, CORS restrictivo.
- **Archivos:** URLs prefirmadas con expiración; validar tipo y tamaño; sin ejecución de contenido subido.
- **Dependencias:** auditoría automática en CI; fijar versiones; revisar dependencias nuevas.
- **Auditoría:** `backoffice.audit_log` en la misma transacción que cada acción del personal (catálogo, pagos, logística, parámetros, alta de personal), con la IP solo como HMAC ([ADR-019](docs/adr/ADR-019.md)).
- **Registro de eventos con hash encadenado** en `order_events`: cada evento incluye el hash del anterior. Cubre trazabilidad sin blockchain.
- Logs sin PII; enmascarar teléfonos y comprobantes.
- **Cabeceras:** `helmet` en todas las respuestas (CSP `default-src 'none'` para la API, HSTS, `nosniff`, sin `X-Powered-By`); revisión en [docs/SECURITY-REVIEW.md](docs/SECURITY-REVIEW.md).
- **Operación:** `GET /health` (vivo), `GET /ready` (base de datos y latido del trabajador; 503 si falla), `GET /metrics` en texto Prometheus solo con `Authorization: Bearer <METRICS_TOKEN>` (sin token configurado, 404). Cada petición deja una línea de log estructurada (`requestId`, método, plantilla de ruta, estado y duración) y la cabecera `X-Request-Id`; nunca la ruta concreta, la consulta ni el cuerpo.
- **Regla de capas:** `eslint-plugin-boundaries` con `default: 'disallow'` y `eslint-import-resolver-typescript`; `test/eslint-layers.spec.ts` comprueba que rechaza imports prohibidos.

---

## 17. Testing

### Pirámide

| Nivel                | Qué cubre                                                                                                             | Herramienta                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Unitarias de dominio | Reglas, cálculos (comisión, flete), máquinas de estado. **Sin IO.**                                                   | Vitest                                            |
| Aplicación           | Casos de uso con **adaptadores en memoria** (fakes)                                                                   | Vitest                                            |
| Contrato de puertos  | Que cada adaptador cumpla el mismo comportamiento (`MessagingPort`, `NotificationPort`, `PaymentPort`, `StoragePort`) | Suite compartida ejecutada contra cada adaptador  |
| Integración          | Repositorios Drizzle contra PostgreSQL real                                                                           | Jest + Testcontainers                             |
| API / e2e            | Endpoints completos con auth y permisos                                                                               | Jest + supertest                                  |
| Sync                 | Escenarios offline: duplicados, conflictos, rechazo, corte a mitad                                                    | Pruebas dedicadas del motor de sync (móvil y API) |
| IA                   | Extracción de borradores contra casos esperados                                                                       | Conjunto de evaluación + `FakeLLMAdapter` en CI   |
| Móvil E2E            | Flujos críticos (publicar offline → sincronizar; pedido; check-in)                                                    | Maestro                                           |

### Cobertura mínima (CI falla si baja)

- `domain`: **≥ 90 %** · `application`: **≥ 80 %** · global: **≥ 75 %**.

### Reglas

- Todo bug corregido añade una prueba que lo reproduzca.
- Los tests de dominio y aplicación **no** tocan red, disco ni reloj real: usar `Clock` inyectable.
- Tests deterministas: sin dependencia de orden ni de fecha actual.
- **Casos obligatorios de pagos:** redondeo de comisión, ledger balanceado, idempotencia de verificación, congelamiento por disputa.
- **Casos obligatorios de pedido:** transiciones válidas e inválidas, cancelación en cada estado.
- No se mockea el dominio; se mockean **puertos**.
- Datos de prueba sintéticos; nunca datos reales de usuarios.

---

## 18. Convenciones de código y Git

### Código

- TypeScript `strict`; sin `any` (usar `unknown` + validación).
- Errores de dominio tipados; los casos de uso devuelven `Result<T, E>` en lugar de lanzar para flujos esperados.
- Funciones pequeñas y con nombre del negocio (`verifyPayment`, no `processData`).
- Archivos `kebab-case.ts`; clases `PascalCase`; variables `camelCase`; constantes `UPPER_SNAKE_CASE`.
- Sin lógica de negocio en controllers, componentes de UI ni adaptadores.
- Comentarios solo para el _por qué_; el _qué_ lo dice el nombre.
- Strings de UI en `i18n/` (español); nunca texto literal en componentes.

### Git

- Ramas: `feat/<modulo>-<descripcion>`, `fix/...`, `chore/...`, `docs/...`.
- Commits: **Conventional Commits** (`feat(payments): add commission calculation`).
- PR pequeños, un propósito, con descripción y prueba asociada.
- `main` protegida: CI verde + 1 revisión.

---

## 19. Comandos (convención de scripts en la raíz)

```bash
cp .env.example .env              # completar credenciales locales antes de levantar servicios
pnpm install                      # dependencias
docker compose up -d              # PostgreSQL 16; requiere variables configuradas en .env
docker compose --profile storage up -d minio  # MinIO opcional (CORS del servidor: MINIO_CORS_ALLOWED_ORIGINS)
pnpm db:migrate                   # aplica las migraciones escritas a mano (drizzle/migrate.ts)
pnpm db:check-migrations          # numeración única y contigua (lo exige el CI)
pnpm db:seed                      # datos sintéticos; solo NODE_ENV=development
pnpm dev                          # API en modo watch
pnpm --filter @tracop/api worker  # trabajador de tareas periódicas y outbox (dist: worker:start; en desarrollo: worker:dev)
pnpm demo:up / demo:check / demo:down  # perfil demo (APP_PROFILE=demo, datos sintéticos): solo API y S3 publicados; ver docs/DEPLOYMENT.md
pnpm backup:restore-check <archivo.dump>  # restaura una copia en un PostgreSQL desechable y muestra los recuentos
pnpm --filter @tracop/api load:test  # prueba de carga básica (búsqueda y push de sync) con Testcontainers; ver docs/LOAD-TEST.md
pnpm outbox:status                # eventos pendientes, en reintento y fallidos por tipo, entregas por consumidor y latido (solo recuentos)
pnpm lint                         # ESLint + check-boundaries
pnpm typecheck                    # tsc en todo el monorepo
pnpm test                         # todas las pruebas (Testcontainers si hay Docker)
pnpm build                        # build de todo
pnpm openapi:export               # regenera docs/openapi.json (luego: prettier --write docs/openapi.json)
pnpm openapi:check                # comprueba que docs/openapi.json está al día
pnpm identity:create-staff --phone "+57 300 000 0000" --name "Nombre" --role admin  # CLI protegido
pnpm telegram:set-webhook         # registra el webhook de Telegram
pnpm catalog:expire-lots          # expira lotes (manual; el trabajador lo hace cada 5 min)
pnpm catalog:purge-orphan-photos  # purga fotos huérfanas (manual; el trabajador lo hace cada hora)
pnpm catalog:backfill-changes     # registra la línea base de cambios del catálogo para sync
pnpm ai:eval-live                 # evaluación con el modelo real (LLM_API_KEY en el entorno; nunca en CI)
pnpm recommendations:import-reference-prices <archivo.csv>  # precios de referencia DANE-SIPSA (CSV documentado en ADR-022)
pnpm storage:configure-cors       # CORS por bucket en S3; MinIO responde que no lo admite
pnpm storage:configure-lifecycle  # expira incoming/ y payment-incoming/ a las 24 h (S3 y MinIO)
```

No existen todavía `dev:mobile`, `test:integration`, `test:e2e` ni `test:contract`. **No usar `db:generate`** (`drizzle-kit generate`): las migraciones se escriben a mano (ver «Reglas de trabajo»).

---

## 20. Variables de entorno (`.env.example`)

La fuente de verdad es el esquema zod de `apps/api/src/shared/infra/env.ts` (validación al arrancar, con valores por defecto) y `.env.example`. Grupos actuales:

| Grupo                         | Variables                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base                          | `NODE_ENV`, `APP_PROFILE`, `PORT`, `DATABASE_URL`, `POSTGRES_*` (docker-compose), `SUPPORTED_LOCALES`, `TRUST_PROXY`, `CORS_ALLOWED_ORIGINS`                                                                                                                                                                                                                                                                                                                           |
| Identidad                     | `JWT_SECRET`, `JWT_ISSUER`, `JWT_AUDIENCE`, `JWT_CLOCK_TOLERANCE_SECONDS`, `OTP_HMAC_SECRET`, `RATE_LIMIT_HMAC_SECRET`, `PRIVACY_POLICY_VERSION`, `ALLOWED_COUNTRY_CODES`, `OTP_*` (longitud, vigencia, intentos y límites por teléfono e IP), `ACCESS_TOKEN_TTL_SECONDS`, `REFRESH_TOKEN_TTL_SECONDS`, `REFRESH_GRACE_SECONDS`, `UNVERIFIED_RETENTION_HOURS`, `JOB_EXPIRE_UNVERIFIED_CRON`, `OTP_SENDER`                                                              |
| Mensajería                    | `TELEGRAM_MODE`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_API_ROOT`, `TELEGRAM_WEBHOOK_PROCESS_TIMEOUT_MS`, `TELEGRAM_RATE_LIMIT_*`                                                                                                                                                                                                                                                                                         |
| Catálogo                      | `CATALOG_LOT_MAX_HORIZON_DAYS`, `CATALOG_SEARCH_*`, `CATALOG_PRODUCT_PROPOSAL_*` (pendientes y límite de frecuencia, PROVISIONALES), `CATALOG_PHOTO_*`                                                                                                                                                                                                                                                                                                                 |
| Almacenamiento                | `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_API_ACCESS_KEY`, `S3_API_SECRET_KEY`, `S3_POLICY_ACCESS_KEY`, `S3_POLICY_SECRET_KEY`; MinIO local: `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `MINIO_CORS_ALLOWED_ORIGINS`                                                                                                                                                                                                                           |
| Sync                          | `SYNC_PUSH_MAX_BODY_BYTES`, `SYNC_PUSH_RATE_LIMIT`, `SYNC_PULL_RATE_LIMIT`, `SYNC_RATE_WINDOW_SECONDS`                                                                                                                                                                                                                                                                                                                                                                 |
| Pedidos                       | `ORDER_QUOTE_TTL_HOURS`, `ORDER_RESERVATION_TTL_HOURS`, `ORDER_SUBTOTAL_ROUNDING`, `ORDER_COMMISSION_RATE_BPS`, `ORDER_FREIGHT_COP` (comisión y flete PROVISIONALES), `ORDER_RATE_LIMIT`, `ORDER_RATE_WINDOW_SECONDS`, `ORDER_LOCK_TIMEOUT_MS`, `ORDER_STATEMENT_TIMEOUT_MS`                                                                                                                                                                                           |
| Confianza (PROVISIONAL)       | `TRUST_RATING_WINDOW_DAYS`, `TRUST_MIN_RATINGS_VISIBLE`, `TRUST_COMMENT_MAX_LENGTH`, `TRUST_VERIFICATION_COOLDOWN_DAYS` (por defecto de los parámetros `trust.*`), `TRUST_RATING_RATE_LIMIT`, `TRUST_VERIFICATION_RATE_LIMIT`, `TRUST_RATE_WINDOW_SECONDS`                                                                                                                                                                                                             |
| Logística                     | `LOGISTICS_LOCATION_MAX_TTL_HOURS` (24, PROVISIONAL), `LOGISTICS_LOCATION_RATE_LIMIT`, `LOGISTICS_LOCATION_RATE_WINDOW_SECONDS`                                                                                                                                                                                                                                                                                                                                        |
| Pagos (PROVISIONAL)           | `PAYMENT_REJECTION_GRACE_HOURS`, `PAYMENT_CLAIM_WINDOW_HOURS`, `PAYMENT_PROOF_MAX_BYTES`, `PAYMENT_PROOF_UPLOAD_URL_TTL_SECONDS`, `PAYMENT_PROOF_DOWNLOAD_URL_TTL_SECONDS`                                                                                                                                                                                                                                                                                             |
| Notificaciones                | `NOTIFICATIONS_MAX_ATTEMPTS`, `NOTIFICATIONS_RETRY_BASE_SECONDS`, `NOTIFICATIONS_RETRY_MAX_SECONDS`, `NOTIFICATIONS_LEASE_SECONDS`                                                                                                                                                                                                                                                                                                                                     |
| Trabajador                    | `JOB_EXPIRE_LOTS_CRON`, `JOB_EXPIRE_ORDERS_CRON`, `JOB_PURGE_PHOTOS_CRON`, `JOB_RETENTION_CRON`, `JOB_OUTBOX_DISPATCH_CRON`, `JOB_ISSUE_SETTLEMENTS_CRON`, `JOB_SEND_NOTIFICATIONS_CRON`, `JOB_WORKER_HEARTBEAT_CRON`, `READY_WORKER_MAX_AGE_SECONDS`, `METRICS_TOKEN`, `OUTBOX_LEASE_SECONDS`, `OUTBOX_MAX_ATTEMPTS`, `OUTBOX_RETRY_BASE_SECONDS`, `OUTBOX_RETRY_MAX_SECONDS`                                                                                         |
| Retención (PROVISIONAL)       | `OTP_RETENTION_DAYS`, `SESSION_RETENTION_DAYS`, `PROCESSED_UPDATES_RETENTION_DAYS`, `RATE_LIMIT_RETENTION_SECONDS`                                                                                                                                                                                                                                                                                                                                                     |
| IA (PROVISIONAL)              | `AI_ENABLED` (false), `LLM_PROVIDER`, `LLM_MODEL` (sin valor por defecto), `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_TIMEOUT_MS`, `LLM_MAX_OUTPUT_TOKENS`, `AI_CONSENT_VERSION`, `AI_DAILY_REQUESTS_PER_USER`, `AI_REQUESTS_PER_MINUTE`, `AI_MONTHLY_TOKEN_CAP`, `AI_DRAFT_TTL_MINUTES`, `AI_FINISHED_DRAFT_RETENTION_DAYS`, `AI_USAGE_RETENTION_DAYS`, `AI_INBOX_LEASE_SECONDS`, `AI_INBOX_MAX_ATTEMPTS`, `JOB_AI_INBOX_CRON`, `JOB_AI_MAINTENANCE_CRON`                    |
| Recomendaciones (PROVISIONAL) | `RECOMMENDATIONS_REFERENCE_MAX_AGE_DAYS`, `RECOMMENDATIONS_OBSERVATION_WINDOW_DAYS`, `RECOMMENDATIONS_MIN_SAMPLE`, `RECOMMENDATIONS_MIN_OWN_OBSERVATIONS`, `RECOMMENDATIONS_MIN_OWN_PROVIDERS`, `RECOMMENDATIONS_WEIGHT_*`, `RECOMMENDATIONS_NEARBY_KM`, `RECOMMENDATIONS_FRESH_HOURS`, `RECOMMENDATIONS_CANDIDATE_LIMIT`, `RECOMMENDATIONS_DEFAULT_RADIUS_KM`, `RECOMMENDATIONS_ALERTS_PER_USER`, `RECOMMENDATIONS_RATE_LIMIT`, `RECOMMENDATIONS_RATE_WINDOW_SECONDS` |
| Futuro (sin uso en el código) | `WHATSAPP_*`, `FCM_CREDENTIALS`, `SMS_API_KEY`, `MAPS_API_KEY`                                                                                                                                                                                                                                                                                                                                                                                                         |

> Nunca commitear `.env`. Solo `.env.example` sin valores.

---

## 21. Definition of Done (checklist de PR)

- [ ] Respeta la regla de dependencia y no importa internals de otro módulo.
- [ ] Lógica de negocio en `domain`/`application`, no en bordes.
- [ ] Pruebas nuevas/actualizadas y cobertura por encima del mínimo.
- [ ] Si toca sync: probados duplicado, conflicto y rechazo.
- [ ] Si toca dinero: enteros, ledger balanceado, idempotencia.
- [ ] Migración incluida, hacia adelante y revisada.
- [ ] Sin secretos ni PII en código, logs o fixtures.
- [ ] Strings de UI en i18n.
- [ ] Docs/ADR actualizados si cambia una decisión.
- [ ] `lint`, `typecheck` y `test` en verde.
- [ ] SonarCloud en verde.
- [ ] CodeQL en verde.

---

## Calidad y seguridad

### Hooks locales

- `pnpm install` ejecuta `prepare` e instala Husky.
- `pre-commit` ejecuta lint-staged (ESLint `--fix` y Prettier sobre archivos modificados).
- `commit-msg` valida Conventional Commits y los scopes permitidos en `.commitlintrc.json`.
- `pre-push` ejecuta `pnpm typecheck` y `pnpm test`.
- Para auditar dependencias manualmente: `pnpm audit --audit-level=high` (falla ante vulnerabilidades high o critical).

### CI y análisis

- `.github/workflows/ci.yml` corre lint, typecheck, tests y auditoría con Node 22; `HUSKY=0` evita instalar hooks dentro de CI.
- Para ejecutar localmente los mismos chequeos base del CI: `pnpm lint && pnpm typecheck && pnpm test && pnpm audit --audit-level=high`.
- SonarCloud se ejecuta en push a `main` y en pull requests del mismo repositorio; omite PRs desde forks porque GitHub no expone secretos allí. Consume los reportes LCOV de Jest y Vitest. Configura el secreto `SONAR_TOKEN` en GitHub y concede a su cuenta permiso de análisis del proyecto. Con SonarScanner CLI instalado localmente, ejecuta `pnpm test` y luego `sonar-scanner` con `SONAR_TOKEN` disponible en el entorno. Verifica que `sonar.organization` y `sonar.projectKey` correspondan a las keys reales; nunca guardes el token en archivos.
- Dependabot revisa semanalmente las dependencias npm del workspace pnpm desde la raíz, GitHub Actions y Docker.
- Dependabot se ejecuta desde GitHub; localmente se pueden inspeccionar versiones con `pnpm outdated -r`.
- CodeQL analiza TypeScript en pull requests y semanalmente. Con CodeQL CLI instalado, se ejecuta localmente con `codeql database create /tmp/tracop-codeql --language=javascript-typescript --source-root .` y `codeql database analyze /tmp/tracop-codeql javascript-typescript --format=sarif-latest --output=/tmp/tracop-codeql.sarif`.

---

## 22. Decisiones de arquitectura vigentes (ADR resumidas)

| ADR | Decisión                                                                      | Tradeoff aceptado                                                                                                  |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 001 | Monolito modular hexagonal                                                    | Menos escalado independiente; mucho menos complejidad operativa en el piloto                                       |
| 002 | Cliente grueso offline-first con outbox y sync                                | Más complejidad de sync y pruebas, a cambio de funcionar sin señal                                                 |
| 003 | **Sin blockchain en el piloto**; eventos con hash encadenado                  | Sin "inmutabilidad total"; se puede anclar a una cadena después                                                    |
| 004 | **Telegram primero**, WhatsApp después vía el mismo puerto                    | La demo valida el flujo pero no la adopción real                                                                   |
| 005 | LLM en el servidor con confirmación humana obligatoria                        | Costo y latencia por uso; mitiga alucinaciones                                                                     |
| 006 | Pagos con conciliación manual en el piloto                                    | Menos automatización, valida la transacción sin integrar pasarela                                                  |
| 007 | PostgreSQL con schema por módulo + pg-boss                                    | Sin Redis ni broker; suficiente para el piloto                                                                     |
| 008 | Autenticación por teléfono + OTP con JWT y refresh rotativo                   | `jose@4` fijado por dual CJS/ESM; gracia de refresh de `REFRESH_GRACE_SECONDS` (30 s) solo si el sucesor no se usó |
| 009 | Mensajería con Telegram (webhook/polling), puerto único                       | Polling solo dev; OTP fire-and-forget; rate limit en memoria                                                       |
| 010 | Núcleo de catálogo (taxonomía curada, lotes, búsqueda)                        | Búsqueda filtra en memoria antes de paginar                                                                        |
| 011 | Fotos de lote con POST prefirmado y re-codificación a WebP                    | Dependencia de sharp (libvips, LGPL) aceptada provisionalmente                                                     |
| 012 | Idempotencia de sync y cursores serializados                                  | Un lock global de secuencia serializa las escrituras del change log                                                |
| 013 | Logística sin coordenadas en su schema; viaje creado por el transportista     | Ubicación exacta solo para el asignado y el personal, en línea, auditada                                           |
| 014 | Pedidos de un proveedor; reserva al aceptar, vence a las 24 h                 | Un pedido sin comprobante se cancela al vencer la reserva                                                          |
| 015 | Propuestas de producto con revisión del personal                              | Revisión manual; deduplicación por tokens con confirmación                                                         |
| 016 | Trabajador con pg-boss y despachador del outbox con lease                     | Entrega al menos una vez; consumidores idempotentes                                                                |
| 017 | Pagos manuales con ledger inmutable y liquidación tras reclamo                | Revisión humana de cada comprobante; reserva retenida mientras tanto                                               |
| 018 | Notificaciones desde el outbox; bandeja siempre, canales tras un puerto       | Push y SMS sin proveedor (skipped); sin escalado ni resúmenes aún                                                  |
| 019 | Audit log transaccional, parámetros editables y métricas al vuelo             | Una consulta corta por parámetro en cada uso; sin snapshots de métricas                                            |
| 020 | Calificaciones solo del comprador con pago verificado; verificación manual    | Colusión comprador-proveedor posible; sin documentos (§23.8)                                                       |
| 021 | Asistente de IA por Telegram: solo extrae; publica la aplicación al confirmar | Precisión real solo medible fuera de CI; límite por minuto por proceso                                             |
| 022 | Recomendaciones y precios por reglas y percentiles; DANE-SIPSA por CSV manual | Formato XLSX sin verificar; uso comercial de datos DANE por confirmar                                              |
| 023 | Google Gemini como segundo proveedor de IA tras `LLMPort`                     | Plan gratuito solo con datos sintéticos (usa los textos); precisión medida aparte                                  |

---

## 23. Decisiones abiertas (no asumir; preguntar)

- Vocabulario definitivo de unidades de producto/lote. La implementación actual acepta provisionalmente: `kg`, `g`, `lb`, `und`, `docena`, `arroba`, `quintal`, `caja`, `mano`, `bulto`.
- Vocabulario controlado para `quality_grade`. Actualmente es texto opcional de hasta 100 caracteres; no hay lista cerrada implementada.

1. **Porcentaje de comisión** y si se aplica por categoría o plan.
2. **Quién asume la comisión** (propuesta por defecto: se descuenta al productor).
3. **Tarifas de flete** del corredor piloto y si es por peso, distancia o fija.
4. **Duración de la ventana de reclamo** antes de liquidar (propuesta: 24–48 h). Implementada como `PAYMENT_CLAIM_WINDOW_HOURS` (48 h, PROVISIONAL); la ventana tras rechazar un comprobante es `PAYMENT_REJECTION_GRACE_HOURS` (4 h, PROVISIONAL).
5. **Corredor, productos y comercios iniciales** del piloto.
6. **Fuente de precios de referencia** para la sugerencia de precios. Implementada con DANE-SIPSA importado a mano en CSV ([ADR-022](docs/adr/ADR-022.md)); falta verificar el formato real del anexo XLSX y confirmar con legal el uso comercial de los datos del DANE.
7. **Proveedor de SMS y de mapas.**
8. **Política de verificación** de proveedores (documentos exigidos). Hoy la verificación es manual con tres comprobaciones y sin documentos ([ADR-020](docs/adr/ADR-020.md)); las ventanas y mínimos de trust son parámetros PROVISIONALES.
9. **Texto del aviso de privacidad y del aviso de IA, y sus versiones.** El aviso de IA del bot es un borrador marcado; `AI_CONSENT_VERSION` no tiene valor por defecto. El valor técnico inicial es `v0-draft`; el equipo debe redactar y aprobar el texto legal.
10. Verify the adapter against a real S3 provider and confirm the minimum IAM permissions for `S3_API_*` and `S3_POLICY_*`.
11. Ciclo de vida del bucket: `pnpm storage:configure-lifecycle` expira a las 24 h (`INCOMING_RETENTION_DAYS`) lo subido y nunca procesado en `incoming/` (fotos) y `payment-incoming/` (comprobantes), y aborta subidas multiparte incompletas; probado contra MinIO, NO verificado contra un S3 real. `catalog:purge-orphan-photos` sigue limpiando huérfanos de `incoming/` y `photos/`.
12. Retención de `sync.change_log` y `sync.processed_operations`: diseñada en [docs/SYNC-RETENTION.md](docs/SYNC-RETENTION.md) y **sin implementar**, porque compactar hoy rompería cursores (marcas de borrado perdidas) o idempotencia (reintentos tardíos); requiere un 410 `cursor_expired`, un plazo máximo de la outbox del cliente y los plazos que decida el equipo.
13. Validar los valores PROVISIONALES de retención de datos personales (`OTP_RETENTION_DAYS` 7, `SESSION_RETENTION_DAYS` 30, `PROCESSED_UPDATES_RETENTION_DAYS` 7) con el equipo y la Ley 1581.
14. Validar las vigencias PROVISIONALES de cotización y reserva (`ORDER_QUOTE_TTL_HOURS` y `ORDER_RESERVATION_TTL_HOURS`, 24 h) y el límite de propuestas pendientes (`CATALOG_PRODUCT_PROPOSAL_PENDING_LIMIT`, 5).
15. Proveedor de almacenamiento de producción: con MinIO, el CORS es del servidor (`MINIO_API_CORS_ALLOW_ORIGIN`); `storage:configure-cors` solo sirve para proveedores con CORS por bucket y no se ha verificado contra un S3 real.

---

## 24. Instrucciones específicas para agentes

1. **Antes de implementar**, identifica el módulo, el caso de uso y los puertos involucrados. Si no cabe en un módulo existente, propón uno nuevo antes de crearlo.
2. **Empieza por el dominio y sus pruebas**, luego la aplicación, luego los adaptadores.
3. **No añadas dependencias** sin justificarlas en el PR (tamaño, mantenimiento, licencia).
4. **No introduzcas** blockchain, microservicios, Redis ni pasarelas de pago sin aprobación explícita.
5. **No inventes** reglas de negocio de §23: usa parámetros configurables y deja la decisión señalada.
6. **No expongas** datos de un usuario a otro rol. Ante la duda, restringe.
7. Si una petición implica saltarse una regla de §5, **detente y pregunta**.
8. Mantén `docs/ARCHITECTURE.md`, `docs/GLOSSARY.md` y las ADR sincronizados con los cambios.
9. Prefiere cambios **pequeños, reversibles y probados** sobre refactors masivos.
10. Al terminar, resume: qué cambió, qué pruebas se añadieron, qué decisiones quedaron abiertas.

---

## 25. Reglas de trabajo

Cómo se trabaja en el repositorio (personas y agentes). Complementan §5, §18, §21 y §24.

### Forma de trabajo

- El usuario revisa los PR y hace los merges. El agente implementa y revisa, pero **no se autoaprueba**: entrega evidencia verificable para que el usuario decida.
- Una carpeta, trabajo **secuencial**: una funcionalidad a la vez. Termina cuando su PR está integrado en `develop`; la siguiente empieza desde un `develop` actualizado.
- Respuestas cortas y directas. Si algo es ambiguo, pregunta; **no lo reinterpretes**.

### Reglas

1. **Plan primero** en tareas nuevas: comprensión, archivos por capa, puertos y riesgos propios. Espera confirmación, salvo que el encargo diga que el diseño ya está decidido.
2. **Un commit por bloque lógico**, con sus pruebas y Conventional Commits con los scopes de `.commitlintrc.json`. Nunca `--force`, `--no-verify` ni reescribir historia publicada. Comprueba `git status` antes de cambiar de rama; no uses `checkout`/`restore`/`reset` sobre rutas con trabajo sin confirmar. No apliques ni borres stashes sin autorización.
3. **Antes de cada push**, verifica desde un clon limpio (sin `.env`, `node_modules` ni `dist`), con Node 22 y los pasos de `.github/workflows/ci.yml` en orden. La caché de Turbo y Node 24 no cuentan.
4. **Informes con evidencia**: archivo, función, nombre de la prueba y salida literal. Marca «NO verificado» lo que no comprobaste. Las pruebas de otras funciones no son evidencia de esta.
5. **Límites entre módulos**: solo se importa `modules/<otro>/index.ts`; `bootstrap/` solo adapta APIs públicas, sin SQL ni reglas de negocio; cada módulo es dueño de su schema; se exportan casos de uso, nunca repositorios.
6. **Migraciones** solo hacia adelante, escritas a mano en `apps/api/drizzle` y aplicadas con `drizzle/migrate.ts` desde una base vacía. Nunca `drizzle-kit generate` ni tocar `meta/_journal.json`. Numeración única y contigua: no reserves números; quien se integra segundo renumera.
7. **Pruebas**: concurrencia contra PostgreSQL real (Testcontainers), sin depender del reloj de pared ni de aserciones por subcadena sobre texto serializado. Cada bug corregido añade la prueba que lo reproduce.
8. **Seguridad y privacidad**: sin PII, direcciones, tokens ni URLs firmadas en logs; autorización y propiedad en la capa de aplicación; respuestas por rol; un tercero recibe 404, no 403; dinero en enteros; UUID v7; UTC. Los valores de negocio de §23 son parámetros configurables marcados «PROVISIONAL», nunca inventados.
9. **Dependencias** solo justificadas (tamaño, mantenimiento, licencia, alternativas). La documentación narrativa se escribe en commits `docs:` aparte al cierre de cada fase y solo describe lo que existe. Regenera `docs/openapi.json` con `pnpm openapi:export`.
10. **PR normal hacia `develop`** con el checklist de §21, marcando lo verificado y lo NO verificado. Espera CI, SonarCloud, CodeQL y Snyk sobre el SHA final. No integres: lo hace el usuario.
