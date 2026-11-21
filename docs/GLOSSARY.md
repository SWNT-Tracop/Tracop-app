# Glosario

Términos de negocio e identificadores de código. Los eventos de dominio usan PascalCase (`UserRegistered`) y las tablas `snake_case` en el schema de su módulo.

| Español                     | Código                                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Lote                        | `Lot`                                                                                                                                                        |
| Producto / categoría        | `Product` / `Category`                                                                                                                                       |
| Pedido                      | `Order`                                                                                                                                                      |
| Cotización                  | `Quote`                                                                                                                                                      |
| Recogida / entrega          | `Pickup` / `Delivery`                                                                                                                                        |
| Viaje / ruta                | `Trip` / `Route`                                                                                                                                             |
| Comisión                    | `Commission`                                                                                                                                                 |
| Flete                       | `Freight`                                                                                                                                                    |
| Liquidación                 | `Settlement`                                                                                                                                                 |
| Asiento contable            | `LedgerEntry`                                                                                                                                                |
| Reputación                  | `Reputation`                                                                                                                                                 |
| Verificación                | `Verification`                                                                                                                                               |
| Incidencia                  | `Incident`                                                                                                                                                   |
| Transportista / perfil      | `Carrier` (`logistics.carriers`)                                                                                                                             |
| Viaje                       | `Trip` (`logistics.trips`): `planned`, `assigned`, `in_progress`, `completed`, `cancelled`                                                                   |
| Parada                      | `TripStop` (`logistics.trip_stops`): `pickup` \| `delivery`                                                                                                  |
| Recogida programada         | `pickup_scheduled` (estado del pedido)                                                                                                                       |
| En camino / entregado       | `in_transit` / `delivered` (estados del pedido)                                                                                                              |
| Check-in                    | `Checkin` (`logistics.checkins`); sin coordenadas                                                                                                            |
| Zona                        | `zone` (texto normalizado; `zoneFromAddress`)                                                                                                                |
| Recomendación de paradas    | `RecommendedStop` (`orderId`, `kind`, `sequence`, `zone`)                                                                                                    |
| Conflicto de viaje          | `findConflictingOrderIds` / `GET /logistics/conflicts`                                                                                                       |
| Eventos de logística        | `TripPlanned`, `TripAssigned`, `TripStarted`, `TripCompleted`, `TripCancelled`, `PickupConfirmed`, `DeliveryConfirmed`, `IncidentOpened`, `IncidentResolved` |
| Cambio sync de logística    | `sync.change_log` con entidad `trip`, `checkin` o `incident`                                                                                                 |
| Versión esperada            | `expectedVersion` (HTTP) / `baseVersion` (sync)                                                                                                              |
| Operación de sincronización | `SyncOperation`                                                                                                                                              |
| Teléfono                    | `PhoneNumber` (E.164)                                                                                                                                        |
| Usuario                     | `User`                                                                                                                                                       |
| Usuario interno (staff)     | `User.createStaff` (`operator`, `finance`, `admin`)                                                                                                          |
| Verificación de teléfono    | `phoneVerifiedAt` (`UserVerified`)                                                                                                                           |
| Código de un solo uso       | `Otp` (`purpose`: `registration` \| `login`)                                                                                                                 |
| Sesión                      | `Session`                                                                                                                                                    |
| Familia de sesión           | `familyId` (todas las sesiones de un dispositivo)                                                                                                            |
| Refresh token               | `refreshToken`; en base de datos solo `refreshHash` (SHA-256)                                                                                                |
| Rotación de refresh         | `Session.rotate` / `rotatedAt`                                                                                                                               |
| Detección de reutilización  | `reuse_detected` (motivo de revocación de la familia)                                                                                                        |
| Motivo de revocación        | `revokedReason` (`new_login`, `logout`, `reuse_detected`)                                                                                                    |
| Access token / JWT          | Access token (`sub`, `role`, `sid`, `did`, `jti`)                                                                                                            |
| Limitador de tasa           | `RateLimiterPort` / `rate_limit_counters`                                                                                                                    |
| Consentimiento              | `Consent` (`identity.consents`, append-only por versión y canal)                                                                                             |
| Dispositivo                 | `Device` (`deviceId`)                                                                                                                                        |
| Vinculación de canal        | `ChannelLink` (`channel`, `channelUserId`)                                                                                                                   |

Ver [ADR-008](adr/ADR-008.md) para la autenticación por teléfono + OTP y [ARCHITECTURE.md](ARCHITECTURE.md#identity-y-autenticación) para las capas del módulo `identity`. Para logística, ver [ADR-013](adr/ADR-013.md) y [ARCHITECTURE.md](ARCHITECTURE.md#logística).
