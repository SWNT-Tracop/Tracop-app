# Retención de las tablas de sync: diseño

Estado: **diseño, sin implementar**. Hoy `sync.change_log` y `sync.processed_operations` crecen sin límite ([AGENTS §23.12](../AGENTS.md)). Este documento explica por qué todavía no se compactan y qué haría falta para hacerlo sin romper los cursores ni la idempotencia.

## Lo que garantizan hoy

| Tabla                       | Para qué sirve                                                                                       | Garantía que depende de ella                                                                                                                                                      |
| --------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sync.change_log`           | Pull: filas con `server_seq > cursor`, en orden, visibles si `owner_user_id` es nulo o es el usuario | **Sin pérdidas:** un cliente con cualquier cursor ya emitido recibe todos los cambios posteriores, incluidas las marcas de borrado (`op: delete`, `payload.tombstone`)            |
| `sync.processed_operations` | Push: el resultado de cada `opId` con el hash del payload                                            | **Idempotencia:** repetir un `opId` con el mismo payload devuelve el resultado anterior y no vuelve a aplicar nada; reutilizarlo con otro payload o desde otro usuario se rechaza |

## Por qué no se compacta todavía

1. **Cursores.** Si se borran filas con `server_seq <= H`, un cliente que lleva tiempo sin conexión con un cursor `c < H` dejaría de recibir los cambios entre `c` y `H`. Lo grave son las marcas de borrado: un lote borrado reaparecería en su base local. El protocolo actual no tiene forma de decirle «tu cursor es demasiado viejo, resincroniza».
2. **Idempotencia.** Si se borra la fila de un `opId`, un reintento muy tardío de esa operación (un móvil que estuvo semanas sin señal) se procesaría como nuevo:
   - un `create` de lote sería idempotente por `entityId` en catalog;
   - un `update` o un `transition` con `baseVersion` acabaría en conflicto de versión, no duplicado;
   - pero un `create` de `checkin` o de `incident` sí depende del registro de la operación para no repetirse.

   Ningún plazo garantiza por sí solo que el cliente ya no reintentará.

Por lo tanto, cualquier compactación implementada hoy rompería alguna de las dos garantías. Según el encargo, queda solo diseñada.

## Diseño propuesto (para cuando haga falta)

### `change_log`: horizonte con resincronización explícita

1. **Horizonte `H`.** Un trabajo calcula `H` = el mayor `server_seq` anterior a `SYNC_CHANGE_LOG_RETENTION_DAYS`, sin cortar nunca por encima del cursor mínimo de los dispositivos activos en ese periodo. Para eso cada pull tendría que guardar el último cursor de cada dispositivo (tabla nueva `sync.device_cursors`).
2. **Compactación segura por entidad.** Por cada `(entity, entity_id)` con filas `<= H` se conserva solo la **última**, y siempre las marcas de borrado mientras el borrado lógico exista en el dominio. Así, quien tenga un cursor anterior a `H` sigue recibiendo el estado final de cada entidad, aunque no la historia intermedia. Para un cliente que aplica «gana la versión más reciente» eso es equivalente.
3. **Cursor caducado.** Si llega un cursor `< H_min`, el horizonte por debajo del cual ya se borraron también las últimas filas, el pull responde **410 `cursor_expired`** y el cliente hace una resincronización completa desde `cursor=0`. Esto exige un cambio de contrato con el móvil (BREAKING, con la etiqueta acordada) y su prueba.
4. **Pruebas obligatorias:**
   - un cliente con cursor anterior a `H` termina con el mismo estado que uno al día;
   - una marca de borrado nunca se pierde;
   - un cursor bajo `H_min` recibe 410;
   - la compactación es concurrente con escrituras (bloqueo de secuencia de ADR-012).

### `processed_operations`: retención acotada por la outbox del cliente

1. El móvil descarta de su outbox local las operaciones con más de `SYNC_CLIENT_OUTBOX_MAX_AGE_DAYS` (contrato nuevo, documentado en MOBILE-INTEGRATION) y nunca reintenta pasado ese plazo.
2. El servidor conserva cada fila al menos el doble de ese plazo (`SYNC_PROCESSED_RETENTION_DAYS ≥ 2 ×`). Con el reloj del cliente sin garantías, el margen es el seguro.
3. Un `opId` que llegue después, ya sin registro, se rechaza con **`operation_expired`** si su UUID v7 indica una fecha anterior a la retención. El UUID v7 trae la marca de tiempo de creación del cliente. Así nunca se vuelve a aplicar.
4. **Pruebas obligatorias:**
   - un reintento dentro del plazo sigue siendo idempotente;
   - un `opId` viejo sin registro se rechaza y no se aplica;
   - el borrado por lotes no bloquea el push.

## Decisiones abiertas

- Los plazos (`SYNC_CHANGE_LOG_RETENTION_DAYS`, `SYNC_CLIENT_OUTBOX_MAX_AGE_DAYS`, `SYNC_PROCESSED_RETENTION_DAYS`) dependen del uso real del piloto y son una decisión del equipo.
- El 410 `cursor_expired` y el `operation_expired` cambian el contrato con el móvil. Se acuerdan con quien mantiene la app antes de implementarlos.
