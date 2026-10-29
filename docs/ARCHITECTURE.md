# Arquitectura

TRACOP adopta un monolito modular con arquitectura hexagonal: los módulos encapsulan dominio, aplicación, puertos y adaptadores; los controladores y adaptadores conectan el exterior con los casos de uso. El dominio no depende de aplicación, adaptadores ni frameworks; aplicación depende de dominio y puertos. Los módulos exponen su superficie pública exclusivamente por `index.ts`.

## Shared

`src/shared/kernel/` contiene elementos compartidos que son parte del lenguaje del dominio y pueden usarse desde `domain`: `Result`, errores base, la interfaz `Clock` e IDs UUID v7. `src/shared/infrastructure/` contiene implementaciones y detalles de infraestructura —por ejemplo `SystemClock`, conexiones de base de datos y clientes externos— y no puede importarse desde el dominio.

Cada módulo es dueño de sus datos. La migración inicial crea schemas para `identity`, `catalog`, `ordering`, `logistics`, `payments`, `notifications`, `trust`, `sync`, `backoffice` y `shared`; crea únicamente `shared.outbox_events`, sin tablas de dominio.
