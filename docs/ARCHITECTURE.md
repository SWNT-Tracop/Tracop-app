# Arquitectura

TRACOP adopta un monolito modular con arquitectura hexagonal: los módulos encapsulan dominio, aplicación, puertos y adaptadores; los controladores y adaptadores conectan el exterior con los casos de uso. El dominio no depende de aplicación, adaptadores ni frameworks; aplicación depende de dominio y puertos. Los módulos exponen su superficie pública exclusivamente por `index.ts`.

## Shared

`src/shared/kernel/` contiene elementos compartidos que son parte del lenguaje del dominio y pueden usarse desde `domain`: `Result`, errores base, la interfaz `Clock` e IDs UUID v7. `src/shared/infra/` contiene implementaciones y detalles de infraestructura —validación de entorno, `SystemClock`, Drizzle/PostgreSQL, `UnitOfWork`, outbox, logging Pino y manejo HTTP— y no puede importarse desde el dominio.

## Identity y autenticación

`identity` implementa el registro y la autenticación por teléfono + OTP sin que el dominio conozca NestJS, PostgreSQL ni el canal de entrega. La aplicación depende de puertos para repositorios, reloj, envío de OTP, tokens, hash y rate limit. Los repositorios Drizzle y el `RateLimiterPort` PostgreSQL son adaptadores de salida; los controladores REST, guard JWT y RBAC son adaptadores de entrada.

El `UnitOfWork` comparte la transacción de PostgreSQL entre cambios de usuario/sesión y escritura en `shared.outbox_events`. El publicador del outbox queda fuera de este alcance. Teléfonos se almacenan normalizados en E.164; claves de rate limit son HMAC de teléfono/IP. OTP se guarda como HMAC ligado al teléfono y propósito; refresh tokens son aleatorios de 256 bits y se persiste su SHA-256. La familia permite revocar todas las sesiones del dispositivo al detectar reutilización.

Los límites de OTP, confianza de proxy, países y vida de tokens se configuran por entorno. Los valores de OTP y expiración son parámetros iniciales ajustables. En desarrollo el sender imprime el OTP en la terminal; en tests se usa sender en memoria. Production requiere un sender real y no inicia sin configuración. `identity.consents` conserva la aceptación por versión de política.

Los contadores de rate limit se limpian perezosamente al escribir. La purga periódica con pg-boss queda para una fase posterior.

`POST /auth/register` y `POST /auth/otp/request` responden con mensajes genéricos que no revelan si el teléfono existe. Internamente, el registro nuevo crea un usuario pendiente y OTP de registro; una cuenta existente puede recibir OTP de login si cumple límites y estado. Los roles `operator`, `finance` y `admin` se crean con el CLI `pnpm identity:create-staff` o el seed de desarrollo, nunca por HTTP.

Las pruebas e2e y de repositorio de identity usan PostgreSQL 16 iniciado con Testcontainers. El texto legal del aviso no está incluido; el equipo debe definirlo antes de cambiar `PRIVACY_POLICY_VERSION=v0-draft`.

Cada módulo es dueño de sus datos. La migración inicial creó schemas para `identity`, `catalog`, `ordering`, `logistics`, `payments`, `notifications`, `trust`, `sync`, `backoffice` y `shared`, junto a `shared.outbox_events`. Las migraciones forward-only posteriores agregan las tablas propias de cada módulo al implementar su funcionalidad. `shared.schema_migrations` conserva el estado técnico del runner; no es una tabla de negocio.
