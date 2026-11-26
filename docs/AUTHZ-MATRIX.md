# Matriz de autorización (ruta × rol)

Generada por `apps/api/test/authz-inventory.e2e-spec.ts` (regenerar con `UPDATE_AUTHZ_MATRIX=1`); la prueba falla si este archivo no coincide con lo que responde la API.

Cada celda es el estado HTTP de una llamada con identificadores aleatorios (UUID v7), un cuerpo válido (el ejemplo sintético de OpenAPI o uno escrito en la prueba) y las consultas obligatorias. Muestra quién pasa la autenticación y la autorización, no el resultado de negocio: `401` sin sesión; `403` el rol no está permitido; `404` recurso inexistente (o ajeno, ver abajo); `2xx` o `409` el rol pasó.

Columna «Roles»: la lista de `@Roles` (la comprueba el guard antes de leer el cuerpo); «en la aplicación» cuando la comprueba el caso de uso; «pública» para las rutas sin sesión de la lista blanca. La autorización por objeto (usuario A frente a usuario B del mismo rol) está en `apps/api/test/authz-objects.e2e-spec.ts`.

Rutas: 103. Fuera de OpenAPI a propósito: `GET /metrics` (Bearer METRICS_TOKEN; 404 without it, so its existence is not revealed); `POST /webhooks/telegram` (X-Telegram-Bot-Api-Secret-Token header).

| Ruta                                                   | Roles                                                        | anonymous | producer | supplier | buyer | carrier | operator | finance | admin |
| ------------------------------------------------------ | ------------------------------------------------------------ | --------- | -------- | -------- | ----- | ------- | -------- | ------- | ----- |
| `DELETE /alerts/{id}`                                  | en la aplicación                                             | 401       | 403      | 403      | 404   | 403     | 403      | 403     | 403   |
| `DELETE /lots/{id}`                                    | producer, supplier                                           | 401       | 400      | 400      | 403   | 403     | 403      | 403     | 403   |
| `DELETE /lots/{id}/photos/{photoId}`                   | producer, supplier                                           | 401       | 404      | 404      | 403   | 403     | 403      | 403     | 403   |
| `DELETE /pricing/mappings/{id}`                        | en la aplicación                                             | 401       | 403      | 403      | 403   | 403     | 404      | 403     | 404   |
| `GET /alerts`                                          | en la aplicación                                             | 401       | 403      | 403      | 200   | 403     | 403      | 403     | 403   |
| `GET /backoffice/audit`                                | en la aplicación                                             | 401       | 403      | 403      | 403   | 403     | 403      | 403     | 200   |
| `GET /backoffice/metrics`                              | en la aplicación                                             | 401       | 403      | 403      | 403   | 403     | 200      | 200     | 200   |
| `GET /backoffice/parameters`                           | en la aplicación                                             | 401       | 403      | 403      | 403   | 403     | 200      | 200     | 200   |
| `GET /catalog/categories`                              | en la aplicación                                             | 401       | 200      | 200      | 200   | 200     | 200      | 200     | 200   |
| `GET /catalog/product-proposals`                       | producer, supplier, operator, admin                          | 401       | 200      | 200      | 403   | 403     | 200      | 403     | 200   |
| `GET /catalog/products`                                | en la aplicación                                             | 401       | 200      | 200      | 200   | 200     | 200      | 200     | 200   |
| `GET /health`                                          | pública                                                      | 200       | 200      | 200      | 200   | 200     | 200      | 200     | 200   |
| `GET /logistics/carrier-profile`                       | carrier                                                      | 401       | 403      | 403      | 403   | 404     | 403      | 403     | 403   |
| `GET /logistics/carriers`                              | operator, admin                                              | 401       | 403      | 403      | 403   | 403     | 200      | 403     | 200   |
| `GET /logistics/conflicts`                             | operator, admin                                              | 401       | 403      | 403      | 403   | 403     | 200      | 403     | 200   |
| `GET /logistics/incidents`                             | carrier, operator, admin                                     | 401       | 403      | 403      | 403   | 200     | 200      | 403     | 200   |
| `GET /logistics/orders/candidates`                     | carrier, operator, admin                                     | 401       | 403      | 403      | 403   | 200     | 200      | 403     | 200   |
| `GET /logistics/trips`                                 | operator, admin                                              | 401       | 403      | 403      | 403   | 403     | 200      | 403     | 200   |
| `GET /logistics/trips/{id}`                            | carrier, operator, admin                                     | 401       | 403      | 403      | 403   | 404     | 404      | 403     | 404   |
| `GET /logistics/trips/{id}/location-pack`              | en la aplicación                                             | 401       | 404      | 404      | 404   | 404     | 404      | 404     | 404   |
| `GET /logistics/trips/{id}/stops`                      | carrier, operator, admin                                     | 401       | 403      | 403      | 403   | 404     | 404      | 403     | 404   |
| `GET /logistics/trips/{id}/stops/{stopId}/location`    | en la aplicación                                             | 401       | 404      | 404      | 404   | 404     | 404      | 404     | 404   |
| `GET /logistics/trips/mine`                            | carrier                                                      | 401       | 403      | 403      | 403   | 200     | 403      | 403     | 403   |
| `GET /lots`                                            | en la aplicación                                             | 401       | 200      | 200      | 200   | 200     | 200      | 200     | 200   |
| `GET /lots/{id}`                                       | en la aplicación                                             | 401       | 404      | 404      | 404   | 404     | 404      | 404     | 404   |
| `GET /lots/mine`                                       | producer, supplier                                           | 401       | 200      | 200      | 403   | 403     | 403      | 403     | 403   |
| `GET /me`                                              | producer, supplier, buyer, carrier, operator, finance, admin | 401       | 200      | 200      | 200   | 200     | 200      | 200     | 200   |
| `GET /me/inbox`                                        | en la aplicación                                             | 401       | 200      | 200      | 200   | 200     | 200      | 200     | 200   |
| `GET /me/notification-preferences`                     | en la aplicación                                             | 401       | 200      | 200      | 200   | 200     | 200      | 200     | 200   |
| `GET /metrics`                                         | pública                                                      | 404       | 404      | 404      | 404   | 404     | 404      | 404     | 404   |
| `GET /orders/{id}`                                     | en la aplicación                                             | 401       | 404      | 404      | 404   | 404     | 404      | 404     | 404   |
| `GET /orders/{orderId}/ledger`                         | en la aplicación                                             | 401       | 403      | 403      | 403   | 403     | 200      | 200     | 200   |
| `GET /orders/{orderId}/payment`                        | en la aplicación                                             | 401       | 404      | 404      | 404   | 404     | 404      | 404     | 404   |
| `GET /orders/incoming`                                 | en la aplicación                                             | 401       | 200      | 200      | 403   | 403     | 403      | 403     | 403   |
| `GET /orders/mine`                                     | en la aplicación                                             | 401       | 200      | 200      | 200   | 200     | 200      | 200     | 200   |
| `GET /payments/{id}`                                   | en la aplicación                                             | 401       | 404      | 404      | 404   | 404     | 404      | 404     | 404   |
| `GET /payments/review`                                 | en la aplicación                                             | 401       | 403      | 403      | 403   | 403     | 200      | 200     | 200   |
| `GET /pricing/mappings`                                | en la aplicación                                             | 401       | 403      | 403      | 403   | 403     | 200      | 403     | 200   |
| `GET /pricing/suggestion`                              | en la aplicación                                             | 401       | 404      | 404      | 403   | 403     | 403      | 403     | 403   |
| `GET /ready`                                           | pública                                                      | 503       | 503      | 503      | 503   | 503     | 503      | 503     | 503   |
| `GET /recommendations/lots`                            | en la aplicación                                             | 401       | 403      | 403      | 200   | 403     | 403      | 403     | 403   |
| `GET /settlements`                                     | en la aplicación                                             | 401       | 200      | 200      | 403   | 200     | 200      | 200     | 200   |
| `GET /sync/pull`                                       | en la aplicación                                             | 401       | 200      | 200      | 200   | 200     | 200      | 200     | 200   |
| `GET /trust/me`                                        | en la aplicación                                             | 401       | 200      | 200      | 403   | 200     | 403      | 403     | 403   |
| `GET /trust/staff/subjects/{userId}`                   | en la aplicación                                             | 401       | 403      | 403      | 403   | 403     | 200      | 403     | 200   |
| `GET /trust/staff/verifications`                       | en la aplicación                                             | 401       | 403      | 403      | 403   | 403     | 200      | 403     | 200   |
| `PATCH /catalog/categories/{id}`                       | operator, admin                                              | 401       | 403      | 403      | 403   | 403     | 404      | 403     | 404   |
| `PATCH /catalog/products/{id}`                         | operator, admin                                              | 401       | 403      | 403      | 403   | 403     | 404      | 403     | 404   |
| `PATCH /lots/{id}`                                     | producer, supplier                                           | 401       | 404      | 404      | 403   | 403     | 403      | 403     | 403   |
| `PATCH /lots/{id}/photos/order`                        | producer, supplier                                           | 401       | 404      | 404      | 403   | 403     | 403      | 403     | 403   |
| `PATCH /me`                                            | producer, supplier, buyer, carrier, operator, finance, admin | 401       | 200      | 200      | 200   | 200     | 200      | 200     | 200   |
| `POST /alerts`                                         | en la aplicación                                             | 401       | 403      | 403      | 404   | 403     | 403      | 403     | 403   |
| `POST /auth/logout`                                    | producer, supplier, buyer, carrier, operator, finance, admin | 401       | 201      | 201      | 201   | 201     | 201      | 201     | 201   |
| `POST /auth/otp/request`                               | pública                                                      | 201       | 429      | 429      | 429   | 429     | 429      | 429     | 429   |
| `POST /auth/otp/verify`                                | pública                                                      | 401       | 401      | 401      | 401   | 401     | 401      | 401     | 401   |
| `POST /auth/refresh`                                   | pública                                                      | 401       | 401      | 401      | 401   | 401     | 401      | 401     | 401   |
| `POST /auth/register`                                  | pública                                                      | 201       | 429      | 429      | 429   | 429     | 429      | 429     | 429   |
| `POST /catalog/categories`                             | operator, admin                                              | 401       | 403      | 403      | 403   | 403     | 201      | 403     | 201   |
| `POST /catalog/product-proposals`                      | producer, supplier                                           | 401       | 201      | 409      | 403   | 403     | 403      | 403     | 403   |
| `POST /catalog/product-proposals/{id}/approve`         | operator, admin                                              | 401       | 403      | 403      | 403   | 403     | 404      | 403     | 404   |
| `POST /catalog/product-proposals/{id}/reject`          | operator, admin                                              | 401       | 403      | 403      | 403   | 403     | 404      | 403     | 404   |
| `POST /catalog/products`                               | operator, admin                                              | 401       | 403      | 403      | 403   | 403     | 201      | 403     | 201   |
| `POST /logistics/carrier-profile`                      | carrier                                                      | 401       | 403      | 403      | 403   | 400     | 403      | 403     | 403   |
| `POST /logistics/incidents`                            | carrier, operator, admin                                     | 401       | 403      | 403      | 403   | 400     | 400      | 403     | 400   |
| `POST /logistics/incidents/{id}/resolve`               | carrier, operator, admin                                     | 401       | 403      | 403      | 403   | 404     | 404      | 403     | 404   |
| `POST /logistics/stops/{id}/checkins`                  | carrier                                                      | 401       | 403      | 403      | 403   | 400     | 403      | 403     | 403   |
| `POST /logistics/trips`                                | carrier                                                      | 401       | 403      | 403      | 403   | 400     | 403      | 403     | 403   |
| `POST /logistics/trips/{id}/assign`                    | carrier                                                      | 401       | 403      | 403      | 403   | 400     | 403      | 403     | 403   |
| `POST /logistics/trips/{id}/cancel`                    | carrier, operator, admin                                     | 401       | 403      | 403      | 403   | 400     | 400      | 403     | 400   |
| `POST /logistics/trips/{id}/complete`                  | carrier                                                      | 401       | 403      | 403      | 403   | 400     | 403      | 403     | 403   |
| `POST /logistics/trips/{id}/reassign`                  | operator, admin                                              | 401       | 403      | 403      | 403   | 403     | 400      | 403     | 400   |
| `POST /logistics/trips/{id}/start`                     | carrier                                                      | 401       | 403      | 403      | 403   | 400     | 403      | 403     | 403   |
| `POST /logistics/trips/recommend`                      | carrier, operator, admin                                     | 401       | 403      | 403      | 403   | 200     | 200      | 403     | 200   |
| `POST /lots`                                           | producer, supplier                                           | 401       | 404      | 409      | 403   | 403     | 403      | 403     | 403   |
| `POST /lots/{id}/cancel`                               | producer, supplier                                           | 401       | 404      | 404      | 403   | 403     | 403      | 403     | 403   |
| `POST /lots/{id}/photos`                               | producer, supplier                                           | 401       | 404      | 404      | 403   | 403     | 403      | 403     | 403   |
| `POST /lots/{id}/photos/{photoId}/confirm`             | producer, supplier                                           | 401       | 404      | 404      | 403   | 403     | 403      | 403     | 403   |
| `POST /lots/{id}/publish`                              | producer, supplier                                           | 401       | 404      | 404      | 403   | 403     | 403      | 403     | 403   |
| `POST /me/inbox/{id}/read`                             | en la aplicación                                             | 401       | 404      | 404      | 404   | 404     | 404      | 404     | 404   |
| `POST /orders`                                         | en la aplicación                                             | 401       | 403      | 403      | 404   | 403     | 403      | 403     | 403   |
| `POST /orders/{id}/accept`                             | en la aplicación                                             | 401       | 404      | 404      | 404   | 404     | 404      | 404     | 404   |
| `POST /orders/{id}/cancel`                             | en la aplicación                                             | 401       | 404      | 404      | 404   | 404     | 404      | 404     | 404   |
| `POST /orders/{orderId}/payment`                       | en la aplicación                                             | 401       | 403      | 403      | 404   | 403     | 403      | 403     | 403   |
| `POST /payments/{id}/dispute`                          | en la aplicación                                             | 401       | 404      | 404      | 404   | 404     | 404      | 404     | 404   |
| `POST /payments/{id}/dispute/resolve`                  | en la aplicación                                             | 401       | 403      | 403      | 403   | 403     | 404      | 404     | 404   |
| `POST /payments/{id}/proof`                            | en la aplicación                                             | 401       | 404      | 404      | 404   | 404     | 404      | 404     | 404   |
| `POST /payments/{id}/proof/confirm`                    | en la aplicación                                             | 401       | 404      | 404      | 404   | 404     | 404      | 404     | 404   |
| `POST /payments/{id}/reject`                           | en la aplicación                                             | 401       | 403      | 403      | 403   | 403     | 404      | 404     | 404   |
| `POST /payments/{id}/verify`                           | en la aplicación                                             | 401       | 403      | 403      | 403   | 403     | 404      | 404     | 404   |
| `POST /pricing/mappings`                               | en la aplicación                                             | 401       | 403      | 403      | 403   | 403     | 404      | 403     | 404   |
| `POST /settlements/{id}/paid`                          | en la aplicación                                             | 401       | 403      | 403      | 403   | 403     | 404      | 404     | 404   |
| `POST /staff/users/{userId}/channels/{channel}/unlink` | en la aplicación                                             | 401       | 403      | 403      | 403   | 403     | 404      | 403     | 404   |
| `POST /sync/push`                                      | en la aplicación                                             | 401       | 201      | 201      | 201   | 201     | 201      | 201     | 201   |
| `POST /trust/ratings`                                  | en la aplicación                                             | 401       | 403      | 403      | 404   | 403     | 403      | 403     | 403   |
| `POST /trust/staff/ratings/{id}/hide`                  | en la aplicación                                             | 401       | 403      | 403      | 403   | 403     | 404      | 403     | 404   |
| `POST /trust/staff/verifications/{providerId}/approve` | en la aplicación                                             | 401       | 403      | 403      | 403   | 403     | 404      | 403     | 404   |
| `POST /trust/staff/verifications/{providerId}/reject`  | en la aplicación                                             | 401       | 403      | 403      | 403   | 403     | 404      | 403     | 404   |
| `POST /trust/staff/verifications/{providerId}/revoke`  | en la aplicación                                             | 401       | 403      | 403      | 403   | 403     | 404      | 403     | 404   |
| `POST /trust/verification-requests`                    | en la aplicación                                             | 401       | 201      | 201      | 403   | 403     | 403      | 403     | 403   |
| `POST /webhooks/telegram`                              | pública                                                      | 401       | 401      | 401      | 401   | 401     | 401      | 401     | 401   |
| `PUT /backoffice/parameters/{key}`                     | en la aplicación                                             | 401       | 403      | 403      | 403   | 403     | 403      | 403     | 200   |
| `PUT /me/notification-preferences`                     | en la aplicación                                             | 401       | 200      | 200      | 200   | 200     | 200      | 200     | 200   |
| `PUT /me/provider-profile`                             | producer, supplier                                           | 401       | 200      | 200      | 403   | 403     | 403      | 403     | 403   |
