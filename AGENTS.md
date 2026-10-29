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
3. **Un módulo, un dueño de datos.** Solo los módulos con datos propios definidos en §11 tienen schema de PostgreSQL; messaging y ai-assistant no crean schema hasta tener datos propios. **Prohibido** hacer joins o consultas directas a tablas de otro módulo. Se comunican por **interfaz pública del módulo** o por **eventos de dominio**.
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
| ORM / migraciones          | Drizzle ORM + drizzle-kit                                                                                 |
| Jobs / colas               | pg-boss (sobre PostgreSQL, sin Redis en el piloto)                                                        |
| Eventos internos           | `@nestjs/event-emitter` + tabla `outbox_events`                                                           |
| Validación / contratos     | zod (paquete compartido `contracts`) + OpenAPI generado                                                   |
| Móvil                      | React Native + Expo (expo-router), TypeScript                                                             |
| BD local móvil             | expo-sqlite + outbox propio de sincronización                                                             |
| Backoffice                 | React + Vite + TypeScript, TanStack Query, Tailwind                                                       |
| Bot de mensajería          | grammY (Telegram, webhook). WhatsApp Cloud API después                                                    |
| IA                         | Anthropic API tras `LLMPort`, salida estructurada validada                                                |
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
    │   │   ├── shared/           # kernel: Result, errores, Clock, ids, EventBus, outbox
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
DE SALIDA    ManualTransferAdapter → pasarela · AnthropicLLMAdapter · Drizzle repos
```

### Puertos principales

| Puerto               | Responsabilidad                                           | Adaptadores                                                                                |
| -------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `MessagingPort`      | Enviar/recibir mensajes, botones, audio, fotos, ubicación | `TelegramAdapter` (ahora), `WhatsAppAdapter` (después), `InMemoryMessagingAdapter` (tests) |
| `NotificationPort`   | Entregar una notificación por un canal                    | `MessagingNotifier`, `FcmAdapter`, `SmsAdapter`, `EmailAdapter`                            |
| `PaymentPort`        | Registrar/verificar pagos                                 | `ManualTransferAdapter` (piloto), pasarela (futuro)                                        |
| `LLMPort`            | Extraer datos estructurados de texto/audio/foto           | `AnthropicLLMAdapter`, `FakeLLMAdapter` (tests)                                            |
| `PriceReferencePort` | Precios de referencia de mercado                          | adaptador de fuente de datos, `StaticPriceAdapter`                                         |
| `StoragePort`        | Guardar fotos y comprobantes                              | `S3StorageAdapter`, `LocalStorageAdapter`                                                  |
| `MapsPort`           | Distancias y geocodificación                              | adaptador de mapas, `FakeMapsAdapter`                                                      |

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

| Módulo          | Responsabilidad                                                                            | Publica eventos                                                                      | Offline                 |
| --------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | ----------------------- |
| `identity`      | Registro, perfiles, roles, vinculación de canales, OTP, sesiones                           | `UserRegistered`, `ChannelLinked`                                                    | Parcial                 |
| `catalog`       | Productos, categorías, lotes, disponibilidad, búsqueda y filtros                           | `LotPublished`, `LotReserved`, `LotExpired`                                          | Sí                      |
| `ordering`      | Solicitudes, cotizaciones, pedidos y estados                                               | `OrderRequested`, `OrderQuoted`, `OrderAccepted`, `OrderDelivered`, `OrderCancelled` | Sí (eventos pendientes) |
| `logistics`     | Agrupar lotes, camiones, rutas, check-ins, incidencias de transporte                       | `TripPlanned`, `PickupConfirmed`, `DeliveryConfirmed`                                | Sí (check-ins locales)  |
| `payments`      | Cotización de costos, comprobantes, verificación, ledger, liquidación                      | `PaymentProofUploaded`, `PaymentVerified`, `SettlementIssued`, `PaymentDisputed`     | No                      |
| `notifications` | Plantillas, preferencias, enrutamiento por canal, reintentos, estado de envío              | `NotificationSent`, `NotificationFailed`                                             | Bandeja local           |
| `messaging`     | Webhooks y adaptadores de canal, normalización a `InboundMessage`, flujos conversacionales | —                                                                                    | No                      |
| `ai-assistant`  | Extracción de borradores desde texto/audio/foto; sugerencia de precios                     | `DraftGenerated`                                                                     | No                      |
| `trust`         | Calificaciones, reputación, verificación de proveedores                                    | `ProviderVerified`, `RatingSubmitted`                                                | Lectura                 |
| `sync`          | Recepción idempotente de operaciones, cursores de pull, resolución de conflictos           | `SyncBatchApplied`                                                                   | Núcleo offline          |
| `backoffice`    | Casos de uso de operación, métricas, parámetros, audit log                                 | —                                                                                    | No                      |

**Regla:** si un módulo necesita datos de otro, usa su `index.ts` (consulta pública) o reacciona a su evento. Nunca su tabla.

---

## 10. Offline-first y sincronización

### Modelo

- El móvil es un **thick client**: SQLite local es la fuente de lectura de la UI.
- Toda mutación se escribe primero en la BD local **y** en la tabla `outbox` local, y la UI se actualiza de inmediato (optimista).
- Un **motor de sync** vacía el outbox cuando hay conexión y luego hace _pull_ de cambios del servidor.

### Operación de sincronización

```ts
type SyncOperation = {
  opId: string; // UUID v7, clave de idempotencia
  deviceId: string;
  entity: string; // 'lot' | 'order' | 'pickup_checkin' | 'payment_proof' ...
  entityId: string;
  type: 'create' | 'update' | 'delete' | 'transition';
  payload: Record<string, unknown>;
  baseVersion?: number; // versión que el cliente conocía
  clientTs: string; // ISO UTC
};
```

- **Push:** `POST /sync/push` con un lote de operaciones. El servidor registra cada `opId` en `sync.processed_operations`; reenviar la misma operación es inocuo.
- **Pull:** `GET /sync/pull?cursor=<server_seq>` devuelve cambios por entidad desde el cursor. El cursor es un entero monotónico del servidor, **no** un timestamp del cliente.
- **Respuesta por operación:** `applied | rejected | conflict` con motivo. El cliente debe manejar los tres.

### Política de conflictos por tipo de dato

| Dato                   | Política                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Perfil, preferencias   | Última escritura gana (por `server_seq`)                                                                                       |
| Lote (edición)         | Optimistic concurrency con `version`; si difiere, conflicto → la UI muestra la versión del servidor y pide confirmar           |
| Inventario / reserva   | **El servidor decide.** La reserva offline es provisional; puede ser rechazada                                                 |
| Pedido y pago          | **Solo eventos append-only** (transiciones). Nunca se sobrescribe estado; se valida la transición contra la máquina de estados |
| Check-ins de logística | Append-only con `clientTs`; el servidor ordena por `server_seq`                                                                |

### Reglas

- Reintentos con espera exponencial; límite de operaciones por lote (p. ej. 50).
- Una operación rechazada **no** bloquea las siguientes independientes.
- Adjuntos (fotos, comprobantes): subida por separado en segundo plano con URL prefirmada; la operación referencia el `mediaRef`.
- Pruebas obligatorias de los escenarios: sin conexión prolongada, reenvío duplicado, conflicto de versión, rechazo de reserva, caída a mitad del lote.

---

## 11. Base de datos

PostgreSQL 16. **schema solo para módulos con datos propios.** Convenciones: `snake_case`, PK `id uuid` (v7), `created_at`, `updated_at`, `deleted_at` (nullable), `version int` donde aplique, montos `bigint` en COP, estados como `text` con `CHECK`.

### Tablas principales (por schema)

**identity**

- `users` (id, role, full_name, phone, status, locale, created_at…)
- `channel_links` (id, user_id, channel, channel_user_id, verified_at) — único por (`channel`, `channel_user_id`)
- `devices` (id, user_id, platform, push_token, last_seen_at)
- `otp_codes` (id, user_id, code_hash, expires_at, consumed_at)
- `sessions` (id, user_id, refresh_hash, device_id, expires_at)
- `provider_profiles` (user_id, display_name, municipality, department, lat, lng, description)

**catalog**

- `categories` (id, name, parent_id)
- `products` (id, category_id, name, unit, attributes jsonb)
- `lots` (id, provider_id, product_id, quantity, unit, unit_price, quality_grade, available_from, available_until, location_lat, location_lng, status, version)
- `lot_photos` (id, lot_id, media_ref)

**ordering**

- `orders` (id, buyer_id, status, delivery_address, delivery_window, created_at, version)
- `order_items` (id, order_id, lot_id, provider_id, quantity, unit_price)
- `quotes` (id, order_id, subtotal, freight, commission, total, valid_until, status)
- `order_events` (id, order_id, type, payload jsonb, actor_id, occurred_at, prev_hash, hash) — **append-only, hash encadenado**

**logistics**

- `carriers` (user_id, vehicle_type, capacity_kg, plate)
- `trips` (id, carrier_id, status, planned_at, route jsonb)
- `trip_stops` (id, trip_id, order_id, kind, sequence, scheduled_at, completed_at)
- `checkins` (id, stop_id, kind, lat, lng, media_ref, client_ts, server_seq)
- `incidents` (id, order_id, trip_id, type, description, status, opened_at, closed_at)

**payments**

- `payments` (id, order_id, method, amount, status, proof_media_ref, verified_by, verified_at)
- `ledger_entries` (id, transaction_id, account, debit, credit, order_id, created_at) — **inmutable; por transacción suma débitos = créditos**
- `settlements` (id, beneficiary_id, order_id, amount, status, issued_at, paid_at)
- `commission_rules` (id, scope, rate_bps, valid_from, valid_to) — tasa en puntos básicos
- `freight_rates` (id, corridor, rate_per_kg, min_charge, valid_from, valid_to)

**notifications**

- `templates` (id, event_type, channel, locale, body)
- `preferences` (user_id, channel_order jsonb, quiet_hours jsonb)
- `deliveries` (id, user_id, event_id, channel, status, attempts, last_error, sent_at, read_at)
- `inbox` (id, user_id, title, body, read_at)

**trust**

- `ratings` (id, order_id, rater_id, ratee_id, score, comment)
- `verifications` (id, provider_id, status, documents jsonb, reviewed_by, reviewed_at)
- `reputation_snapshots` (provider_id, score, orders_count, on_time_rate, updated_at)

**sync**

- `processed_operations` (op_id pk, device_id, entity, result, server_seq, processed_at)
- `change_log` (server_seq bigserial, entity, entity_id, op, payload jsonb, occurred_at)

**backoffice**

- `audit_log` (id, actor_id, action, entity, entity_id, before jsonb, after jsonb, at, ip)
- `parameters` (key, value jsonb, updated_by, updated_at)

**shared**

- `outbox_events` (id, aggregate, type, payload jsonb, created_at, published_at)

### Reglas de base de datos

- Migraciones **solo hacia adelante** con drizzle-kit; nunca editar una migración ya aplicada.
- Índices obligatorios: FK, `lots(product_id, status)`, `lots` geoespacial si se usa búsqueda por cercanía, `change_log(server_seq)`.
- Integridad del ledger: restricción/trigger o prueba que verifique débitos = créditos por `transaction_id`.
- Datos personales (teléfono, documentos) con acceso restringido; ver §16.
- Seeds de desarrollo en `apps/api/drizzle/seed/` con datos sintéticos, **nunca** datos reales.

---

## 12. Máquinas de estado

Las transiciones se validan en el **dominio**; un estado inválido lanza error de dominio, nunca se "corrige" en silencio.

**Lote:** `draft → published → reserved → sold_out` · `published → expired` · `published|reserved → cancelled`

**Pedido:**
`draft → requested → quoted → accepted → payment_pending → paid → pickup_scheduled → in_transit → delivered → closed`
Desde casi cualquier estado previo a `in_transit`: `→ cancelled`. Desde `delivered`: `→ disputed → closed`.

**Pago:** `pending → proof_uploaded → verified → held → settled` · `proof_uploaded → rejected` · `verified|held → disputed`

**Viaje:** `planned → assigned → in_progress → completed` · `→ cancelled`

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

> Quién asume la comisión y su porcentaje son **decisiones abiertas** (§23). Implementa la tasa y el responsable como **parámetros**, no como constantes.

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
- Todo cambio de estado de pago escribe en `audit_log`.

---

## 14. Notificaciones

**Flujo:** evento de dominio → `NotificationService` → preferencias del usuario → plantilla/idioma → canal → adaptador → registro en `deliveries`.

- **Prioridad de canal:** mensajería (Telegram/WhatsApp) → push → SMS (solo críticos) → correo (recibos a compradores).
- **Eventos con plantilla:** pedido nuevo, cotización, aceptación, recogida programada, en camino, entregado, pago verificado, liquidación, incidencia.
- **Reglas:** escalado a otro canal si no hay lectura/confirmación en N minutos; horario sin molestias (excepto críticos); agrupación en resumen; reintentos con espera creciente; deduplicación por (`event_id`, `user_id`, `channel`).
- **Interactivas:** botones de mensajería (confirmar/rechazar) vuelven como `InboundMessage` de tipo `action` y ejecutan el caso de uso correspondiente.
- **Offline:** la app muestra una bandeja (`inbox`) sincronizada; lo crítico además sale por mensajería/SMS.
- Costos: SMS y WhatsApp cuestan; usar el canal gratuito cuando sea posible.

---

## 15. Mensajería y asistente de IA

### Canal (Telegram primero)

- Webhook de Telegram con **secret token** verificado en cabecera.
- Vinculación de identidad: botón de compartir contacto o código de vinculación → crea `channel_links`.
- El bot soporta texto, voz, fotos, ubicación y botones. Todo se normaliza a `InboundMessage`.
- Migrar a WhatsApp = escribir `WhatsAppAdapter` contra `MessagingPort` (+ plantillas aprobadas por Meta); **cero cambios en dominio/aplicación**.
- Todo adaptador debe pasar el **test de contrato de `MessagingPort`** (§17).

### Flujo de publicación asistida

1. El productor envía mensaje/audio/foto describiendo su lote.
2. `ai-assistant` extrae: producto, cantidad, unidad, calidad, ubicación, fechas, precio.
3. Se muestra un **borrador** con los campos y los faltantes marcados.
4. El productor corrige/confirma → recién entonces se ejecuta `PublishLot`.

### Sugerencia de precios

- Fase 1: reglas con `PriceReferencePort` + histórico propio de TRACOP. Siempre se presenta como **sugerencia con su fuente**, nunca como valor impuesto.
- ML queda para después de tener datos suficientes.

### Reglas de IA

- Prompts versionados en `modules/ai-assistant/prompts/`.
- Salida validada con zod; si falla, se pide aclaración al usuario (no se reintenta indefinidamente).
- Registrar costo/latencia por llamada. Sin datos personales innecesarios en los prompts.
- Evaluaciones: conjunto de casos reales anonimizados con resultado esperado (§17).

---

## 16. Seguridad y privacidad

- **Autenticación:** teléfono + OTP entregado por el canal vinculado (o SMS); JWT de corta vida + refresh rotativo por dispositivo.
- **Autorización:** RBAC por rol + verificación de propiedad del recurso (un productor solo ve/edita lo suyo).
- **Datos personales:** cumplir la **Ley 1581 de 2012** (protección de datos personales, Colombia): consentimiento explícito, finalidad clara, derecho a consulta y supresión. Cifrar en reposo; minimizar lo que se envía a terceros (incluida la IA).
- **Webhooks:** verificar firma/secret; rechazar replays.
- **API:** rate limiting, validación de entrada con zod en cada borde, tamaño máximo de cargas, CORS restrictivo.
- **Archivos:** URLs prefirmadas con expiración; validar tipo y tamaño; sin ejecución de contenido subido.
- **Dependencias:** auditoría automática en CI; fijar versiones; revisar dependencias nuevas.
- **Auditoría:** `audit_log` para acciones del backoffice y cambios de pago.
- **Registro de eventos con hash encadenado** en `order_events`: cada evento incluye el hash del anterior. Cubre trazabilidad sin blockchain.
- Logs sin PII; enmascarar teléfonos y comprobantes.

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
pnpm install              # dependencias
pnpm dev                  # api + backoffice (+ docker compose up -d para db/minio)
pnpm dev:mobile           # Expo
pnpm lint                 # ESLint + límites de módulos
pnpm typecheck            # tsc en todo el monorepo
pnpm test                 # unitarias + aplicación
pnpm test:integration     # Testcontainers (requiere Docker)
pnpm test:e2e             # API e2e
pnpm test:contract        # contratos de puertos
pnpm db:generate          # drizzle-kit: generar migración
pnpm db:migrate           # aplicar migraciones
pnpm db:seed              # datos sintéticos
pnpm build                # build de todo
```

---

## 20. Variables de entorno (`.env.example`)

```
NODE_ENV=development
DATABASE_URL=postgres://tracop:tracop@localhost:5432/tracop
JWT_SECRET=
JWT_REFRESH_SECRET=

# Mensajería
TELEGRAM_BOT_TOKEN=
TELEGRAM_WEBHOOK_SECRET=
WHATSAPP_ACCESS_TOKEN=            # futuro
WHATSAPP_VERIFY_TOKEN=            # futuro

# IA
LLM_API_KEY=
LLM_MODEL=                        # configurable, no hardcodear

# Almacenamiento
S3_ENDPOINT=
S3_BUCKET=
S3_ACCESS_KEY=
S3_SECRET_KEY=

# Notificaciones
FCM_CREDENTIALS=
SMS_API_KEY=

# Otros
PRICE_REFERENCE_SOURCE=
MAPS_API_KEY=
```

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
- `pre-commit` ejecuta lint-staged (ESLint `--fix` y Prettier sobre archivos modificados). Si `gitleaks` está instalado, también escanea el contenido staged.
- `commit-msg` valida Conventional Commits y los scopes permitidos en `.commitlintrc.json`.
- `pre-push` ejecuta `pnpm typecheck` y `pnpm test`.
- Para escanear secretos manualmente: `gitleaks detect --source . --redact`.
- Para auditar dependencias manualmente: `pnpm audit --audit-level=high` (falla ante vulnerabilidades high o critical).

### CI y análisis

- `.github/workflows/ci.yml` corre lint, typecheck, tests y auditoría con Node 22; `HUSKY=0` evita instalar hooks dentro de CI.
- SonarCloud se ejecuta en push a `main` y en pull requests; consume los reportes LCOV de Jest y Vitest. Requiere `SONAR_TOKEN` y completar los marcadores `sonar.organization` y `sonar.projectKey`.
- Dependabot revisa semanalmente dependencias npm de workspaces, GitHub Actions y Docker.
- CodeQL analiza TypeScript en pull requests y semanalmente.
- Gitleaks escanea pull requests; el hook local es adicional y solo se activa si la herramienta está instalada.

---

## 22. Decisiones de arquitectura vigentes (ADR resumidas)

| ADR | Decisión                                                     | Tradeoff aceptado                                                            |
| --- | ------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| 001 | Monolito modular hexagonal                                   | Menos escalado independiente; mucho menos complejidad operativa en el piloto |
| 002 | Cliente grueso offline-first con outbox y sync               | Más complejidad de sync y pruebas, a cambio de funcionar sin señal           |
| 003 | **Sin blockchain en el piloto**; eventos con hash encadenado | Sin "inmutabilidad total"; se puede anclar a una cadena después              |
| 004 | **Telegram primero**, WhatsApp después vía el mismo puerto   | La demo valida el flujo pero no la adopción real                             |
| 005 | LLM en el servidor con confirmación humana obligatoria       | Costo y latencia por uso; mitiga alucinaciones                               |
| 006 | Pagos con conciliación manual en el piloto                   | Menos automatización, valida la transacción sin integrar pasarela            |
| 007 | PostgreSQL con schema por módulo + pg-boss                   | Sin Redis ni broker; suficiente para el piloto                               |

---

## 23. Decisiones abiertas (no asumir; preguntar)

1. **Porcentaje de comisión** y si se aplica por categoría o plan.
2. **Quién asume la comisión** (propuesta por defecto: se descuenta al productor).
3. **Tarifas de flete** del corredor piloto y si es por peso, distancia o fija.
4. **Duración de la ventana de reclamo** antes de liquidar (propuesta: 24–48 h).
5. **Corredor, productos y comercios iniciales** del piloto.
6. **Fuente de precios de referencia** para la sugerencia de precios.
7. **Proveedor de SMS y de mapas.**
8. **Política de verificación** de proveedores (documentos exigidos).

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
