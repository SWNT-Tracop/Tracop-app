# Módulo `identity`

Registro y autenticación por teléfono + OTP, sesiones con refresh rotativo, perfil del usuario autenticado y RBAC. Arquitectura hexagonal: el dominio no conoce NestJS, PostgreSQL ni el canal de entrega.

La descripción de capas, el flujo completo y las decisiones están en [ARCHITECTURE.md](../../../../../docs/ARCHITECTURE.md#identity-y-autenticación) y [ADR-008](../../../../../docs/adr/ADR-008.md). Este archivo solo resume la superficie y los puntos de integración.

## Superficie pública

`index.ts` exporta únicamente `IdentityModule`. Otros módulos no deben importar rutas internas ni inyectar los tokens del módulo; para leer datos de identity usan su interfaz pública o reaccionan a eventos.

El `IdentityModule` de NestJS exporta además los tokens `IDENTITY_APPLICATION` y `OTP_SENDER`, usados por las pruebas de integración para inyectar un sender en memoria. No son API estable para otros módulos.

## Endpoints

| Método  | Ruta                | Acceso                         | Caso de uso      |
| ------- | ------------------- | ------------------------------ | ---------------- |
| `POST`  | `/auth/register`    | público                        | `registerUser`   |
| `POST`  | `/auth/otp/request` | público                        | `requestOtp`     |
| `POST`  | `/auth/otp/verify`  | público                        | `verifyOtp`      |
| `POST`  | `/auth/refresh`     | público (refresh + `deviceId`) | `refreshSession` |
| `POST`  | `/auth/logout`      | Bearer + rol                   | `logout`         |
| `GET`   | `/me`               | Bearer + rol                   | `getMe`          |
| `PATCH` | `/me`               | Bearer + rol                   | `updateMe`       |

Los contratos de entrada viven en `@tracop/contracts` (`registerUserSchema`, `requestOtpSchema`, `verifyOtpSchema`, `refreshSessionSchema`, `updateMeSchema`).

## Casos de uso

`IdentityApplicationService` devuelve `Result<T, DomainError>` para los flujos esperados:

- `registerUser`: valida teléfono, rol auto-registrable y consentimiento vigente; crea usuario pendiente, dispositivo, consentimiento y OTP. La respuesta es genérica para no revelar si el teléfono existe.
- `requestOtp`: aplica límites por teléfono e IP y emite un OTP de `registration` o `login` según el estado de la cuenta.
- `verifyOtp`: valida y consume el OTP, activa al usuario, revoca la familia previa del dispositivo y emite tokens.
- `refreshSession`: rota el refresh dentro de la familia; detecta reutilización y revoca la familia.
- `logout`: revoca la sesión del `sid` del access token.
- `getMe` / `updateMe`: leen y actualizan nombre y locale del usuario autenticado.

## Puertos y adaptadores

| Puerto                                                                                          | Adaptador(es)                                                 |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `TokenServicePort` (asíncrono)                                                                  | `HmacTokenService` (`jose@4.15.9`, HS256)                     |
| `OtpSenderPort`                                                                                 | `DevelopmentOtpSender` (consola), `InMemoryOtpSender` (tests) |
| `RateLimiterPort`                                                                               | `PostgresRateLimiter`                                         |
| `PasswordlessHasherPort`                                                                        | `HmacPasswordlessHasher` (HMAC-SHA256 y SHA-256)              |
| `UserRepository`, `OtpRepository`, `SessionRepository`, `DeviceRepository`, `ConsentRepository` | Repositorios Drizzle del schema `identity`                    |
| `IdentityUnitOfWork`                                                                            | `UnitOfWork` compartido (transacción + outbox)                |

Entrada: `IdentityController`, `IdentityAuthGuard`, `auth-metadata.ts` (`@Public`, `@Roles`).

## Eventos

Se escriben en `shared.outbox_events` dentro de la misma transacción que el cambio de estado:

| Evento           | Cuándo                                                            |
| ---------------- | ----------------------------------------------------------------- |
| `UserRegistered` | alta de usuario por HTTP o por CLI de staff                       |
| `UserVerified`   | primer OTP correcto de una cuenta `pending_verification`          |
| `SessionRevoked` | logout, nuevo login o reutilización de refresh (`reuse_detected`) |

El publicador del outbox no forma parte de este módulo.

## Datos y migraciones

Schema `identity`: `users`, `channel_links`, `devices`, `otp_codes`, `sessions`, `provider_profiles`, `consents`, `rate_limit_counters`. Migraciones forward-only `0000`–`0003`; `consents` es append-only por trigger y `sessions` tiene un índice único de sesión viva por dispositivo.

## Pruebas

```bash
pnpm --filter @tracop/api test
```

Jest corre con `--coverage` y levanta PostgreSQL 16 con Testcontainers (requiere Docker). La cobertura se mide sobre `src/bootstrap/app.module.ts`, `src/modules/identity/domain/**`, `src/modules/identity/application/**` y `src/shared/kernel/**`; umbrales: dominio 90 % de líneas, aplicación 80 %, global 75 %.

Pruebas relevantes en `apps/api/test/`: `identity.e2e-spec.ts` (flujo, concurrencia y reuse detection), `identity-logging.e2e-spec.ts` (redacción de logs), `identity-application.spec.ts`, `identity-authorization.spec.ts` y `otp-sender.contract-spec.ts`.

## Pendientes

- No existe `OtpSenderPort` de producción: solo consola (desarrollo) y memoria (tests). Producción no inicia sin un sender real.
- Ventana de gracia de refresh para redes inestables: propuesta en ADR-008, no implementada. El cliente no debe lanzar refresh en paralelo con el mismo token.
- Purga periódica de OTP y contadores de rate limit con pg-boss.
