# Arquitectura

TRACOP adopta un monolito modular con arquitectura hexagonal: los módulos encapsulan dominio, aplicación, puertos y adaptadores; los controladores y adaptadores conectan el exterior con los casos de uso. El dominio no depende de aplicación, adaptadores ni frameworks; aplicación depende de dominio y puertos. Los módulos exponen su superficie pública exclusivamente por `index.ts`.

## Shared

`src/shared/kernel/` contiene elementos compartidos que son parte del lenguaje del dominio y pueden usarse desde `domain`: `Result`, errores base, la interfaz `Clock` e IDs UUID v7. `src/shared/infra/` contiene implementaciones y detalles de infraestructura —validación de entorno, `SystemClock`, Drizzle/PostgreSQL, `UnitOfWork`, outbox, logging Pino y manejo HTTP— y no puede importarse desde el dominio.

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
