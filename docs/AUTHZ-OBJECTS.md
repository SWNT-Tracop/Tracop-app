# Autorización por objeto

Generada por `apps/api/test/authz-objects.e2e-spec.ts` (regenerar con `UPDATE_AUTHZ_MATRIX=1`); la prueba falla si este archivo no coincide. El usuario A crea cada recurso y el usuario B lo pide: la respuesta debe ser `404`, la misma que para un recurso que no existe, y los datos de A no deben cambiar (se comparan antes y después).

| Ruta                                                             | Dueño     | Quien lo pide            | Estado |
| ---------------------------------------------------------------- | --------- | ------------------------ | ------ |
| `GET /lots/{borrador de A}`                                      | producerA | producerB                | 404    |
| `GET /lots/{borrador de A}`                                      | producerA | buyerB                   | 404    |
| `PATCH /lots/{borrador de A}`                                    | producerA | producerB                | 404    |
| `DELETE /lots/{borrador de A}`                                   | producerA | supplierB                | 404    |
| `POST /lots/{borrador de A}/publish`                             | producerA | producerB                | 404    |
| `POST /lots/{lote publicado de A}/cancel`                        | producerA | producerB                | 404    |
| `POST /lots/{borrador de A}/photos`                              | producerA | producerB                | 404    |
| `POST /lots/{borrador de A}/photos/{foto de A}/confirm`          | producerA | producerB                | 404    |
| `DELETE /lots/{borrador de A}/photos/{foto de A}`                | producerA | producerB                | 404    |
| `PATCH /lots/{borrador de A}/photos/order`                       | producerA | producerB                | 404    |
| `GET /orders/{pedido de A}`                                      | buyerA    | buyerB                   | 404    |
| `GET /orders/{pedido de A}`                                      | buyerA    | producerB                | 404    |
| `POST /orders/{pedido de A}/accept`                              | buyerA    | buyerB                   | 404    |
| `POST /orders/{pedido de A}/cancel`                              | buyerA    | buyerB                   | 404    |
| `GET /orders/{pedido de A}/payment`                              | buyerA    | buyerB                   | 404    |
| `POST /orders/{pedido de A}/payment`                             | buyerA    | buyerB                   | 404    |
| `GET /payments/{pago de A}`                                      | buyerA    | buyerB                   | 404    |
| `GET /payments/{pago de A}`                                      | buyerA    | producerB                | 404    |
| `POST /payments/{pago de A}/proof`                               | buyerA    | buyerB                   | 404    |
| `POST /payments/{pago de A}/proof/confirm`                       | buyerA    | buyerB                   | 404    |
| `POST /payments/{pago de A}/dispute`                             | buyerA    | buyerB (wrong version)   | 404    |
| `POST /payments/{pago de A}/dispute`                             | buyerA    | buyerB (current version) | 404    |
| `GET /logistics/trips/{viaje de A}`                              | carrierA  | carrierB                 | 404    |
| `GET /logistics/trips/{viaje de A}/stops`                        | carrierA  | carrierB                 | 404    |
| `POST /logistics/trips/{viaje de A}/start`                       | carrierA  | carrierB                 | 404    |
| `POST /logistics/trips/{viaje de A}/complete`                    | carrierA  | carrierB                 | 404    |
| `POST /logistics/trips/{viaje de A}/cancel`                      | carrierA  | carrierB                 | 404    |
| `POST /logistics/stops/{parada de A}/checkins`                   | carrierA  | carrierB                 | 404    |
| `GET /logistics/trips/{viaje de A}/stops/{parada de A}/location` | carrierA  | carrierB                 | 404    |
| `GET /logistics/trips/{viaje de A}/location-pack`                | carrierA  | carrierB                 | 404    |
| `GET /logistics/trips/{viaje de A}/stops/{parada de A}/location` | carrierA  | buyerB                   | 404    |
| `GET /logistics/trips/{viaje de A}/location-pack`                | carrierA  | buyerB                   | 404    |
| `GET /logistics/trips/{viaje de A}/stops/{parada de A}/location` | carrierA  | buyerA                   | 404    |
| `GET /logistics/trips/{viaje de A}/location-pack`                | carrierA  | buyerA                   | 404    |
| `GET /logistics/trips/{viaje de A}/stops/{parada de A}/location` | carrierA  | producerA                | 404    |
| `GET /logistics/trips/{viaje de A}/location-pack`                | carrierA  | producerA                | 404    |
| `POST /me/inbox/{aviso de A}/read`                               | producerA | producerB                | 404    |
| `DELETE /alerts/{alerta de A}`                                   | buyerA    | buyerB                   | 404    |
| `POST /trust/ratings`                                            | buyerA    | buyerB                   | 404    |
