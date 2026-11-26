# Vitrina de demostración (servidor de la sustentación)

La vitrina llena el servidor de demo (`docker-compose.aws.yml`, perfil `demo`) con **31 cuentas sintéticas** y su actividad, para que la app se vea con datos reales de uso. **Todas las cuentas quedan suspendidas:** no reciben código, no se pueden vincular a Telegram y no pueden hacer ninguna petición. Los jurados entran con **su propio celular**.

## Qué crea

| Números (`+57 300 000 00NN`) | Rol           | Qué tienen                                                                               |
| ---------------------------- | ------------- | ---------------------------------------------------------------------------------------- |
| `00`                         | admin         | —                                                                                        |
| `01`–`05`                    | productor     | Perfil de proveedor y 2 lotes publicados con foto cada uno                               |
| `06`–`10`                    | proveedor     | Igual; uno propone el producto «Ahuyama» (pendiente)                                     |
| `11`–`15`                    | comprador     | Por cada uno: 1 pedido entregado y calificado, y 1 pedido pagado esperando transportista |
| `16`–`20`                    | transportista | Perfil de vehículo; hicieron los viajes de los pedidos entregados                        |
| `21`–`25`                    | operador      | Crearon el catálogo y verificaron a 3 proveedores (1 pendiente)                          |
| `26`–`30`                    | finanzas      | Verificaron los pagos                                                                    |

- **Catálogo del corredor:** papa criolla, mora de Castilla, cebolla cabezona, uchuva, zanahoria, fresa, lulo y tomate chonto, en kg. Se reutilizan si ya existen con el mismo nombre.
- **Ubicaciones:** centros de municipios de Boyacá y Cundinamarca (DANE DIVIPOLA).
- **Fotos:** de Wikimedia Commons con licencia libre (CC0, dominio público, CC BY y CC BY-SA). El autor, la licencia y la fuente de cada una están en `apps/api/scripts/showcase/photos/credits.json`; al mostrarlas en público, se cita al autor.
- **Nombres:** empiezan por `[DEMO]`. Las direcciones son sintéticas.

Todo se hace por la **API real**, con sesiones que el seed emite para cada cuenta. Por eso quedan los mismos eventos, la auditoría, el ledger y las notificaciones que en el uso normal. Al final, todas las cuentas se suspenden. **Si algo falla a mitad, también se suspenden.**

## Cuándo corre

- **En cada despliegue** (`scripts/deploy/aws-demo.sh`): al final, con la API ya sana, corre `showcase-seed --skip-if-seeded`.
  - Si la vitrina ya existe, no hace nada.
  - **Si la base se vació, la vuelve a crear.**
  - Un fallo no revierte el despliegue.
  - `SHOWCASE_SEED=off` lo desactiva.
- **En cada `docker compose up`** del stack de AWS: el servicio de un solo uso `showcase` hace lo mismo.
- **Nunca borra nada por su cuenta.**

## Comandos (en el servidor, dentro del contenedor de la API)

```bash
compose=(docker compose --project-name tracop-aws --env-file .env.demo -f docker-compose.aws.yml)
"${compose[@]}" exec api node dist/scripts/showcase-seed.js                   # sembrar a mano
"${compose[@]}" exec api node dist/scripts/showcase-purge.js --confirm        # quitar la vitrina
"${compose[@]}" exec api node dist/scripts/create-staff.js \
  --phone "+57 3XX XXX XXXX" --name "Nombre" --role admin --promote           # volver admin una cuenta existente
```

- **`showcase-purge`:**
  - cancela los lotes que siguen en oferta;
  - retira las 31 cuentas igual que la retención de identity: seudónimo en el teléfono, nombre vacío, y sin sesiones, dispositivos, vínculos ni perfil;
  - libera las placas de los transportistas.

  Los pedidos, los pagos, el ledger, las calificaciones y la auditoría se conservan, porque son inmutables.

- **`create-staff --promote`:** convierte en personal una cuenta que ya existe (por ejemplo, la de alguien del equipo que se registró en la app). Cierra sus sesiones y deja `staff.promote` en la auditoría. **El número real se escribe solo en el comando, en el servidor; nunca en el repositorio.**
- **En desarrollo:** con la demo local en marcha, `pnpm --filter @tracop/api showcase:seed` y `showcase:purge`.

## Seguridad

- Solo corre en los perfiles `development` o `demo`. Se niega con `NODE_ENV=production` o con `APP_PROFILE=production`.
- Las cuentas suspendidas no reciben código ni se pueden vincular a Telegram, aunque alguien sea el dueño real de uno de esos números.
- Los jurados prueban otros roles porque el admin los cambia desde **Backoffice → Cuentas** (`POST /staff/users/{id}/role`), con auditoría.
