# Despliegue, demo y copias de seguridad

## Perfiles (`APP_PROFILE`)

| Perfil                      | `NODE_ENV`               | Datos                       | Para qué                                                                                                                     |
| --------------------------- | ------------------------ | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `development` (por defecto) | `development` o `test`   | Sintéticos (`pnpm db:seed`) | Trabajo local; Swagger en `/docs`                                                                                            |
| `demo`                      | nunca `production`       | Solo sintéticos             | Mostrar el producto: OTP capturado en un archivo privado del contenedor (nunca en los logs), sin Swagger y sin Telegram real |
| `production`                | `production` obligatorio | Reales                      | El piloto: exige Telegram, HTTPS, S3 y todos los secretos (`env.ts`)                                                         |

La aplicación no arranca con `APP_PROFILE=production` sin `NODE_ENV=production`, ni con `APP_PROFILE=demo` y `NODE_ENV=production`. `db:seed` se niega fuera de `development` y `demo`.

## Demo local

### Actualizaciones de la demo AWS desde `main`

El CI valida cada PR y push. Solo un push a `main`, o la ejecución manual de
**CI** sobre `main`, llama al despliegue después de que `validate` termine bien.
Se construye en EC2 el mismo SHA validado. Un PR o push a otra rama no despliega.
La protección de `main` exige una aprobación y CI antes de integrar el PR.

El repositorio necesita los secretos `EC2_HOST`, `EC2_USER`, `EC2_SSH_KEY` y la
variable `API_BASE_URL` con el origen HTTPS, sin barra final. El usuario SSH debe
poder ejecutar `sudo -n`; `/opt/tracop` debe ser un clon limpio con acceso de
lectura a GitHub y una demo previamente inicializada.

`scripts/deploy/aws-demo.sh` conserva `.env.demo`, los overrides privados,
Telegram, Gemini y el proxy HTTPS. Guarda un dump antes de migrar, ejecuta
únicamente migraciones y actualiza API/worker sin volver a sembrar datos ni
recrear la base. Los despliegues se serializan y omiten commits superados por
otro push a `main`. Swagger conserva sus rutas y actualiza el esquema exportado.

Cada ejecución guarda imágenes anteriores, configuración privada y dump en
`/opt/tracop-deployments/release-<sha>.*` (directorio `700`, archivos `600`).
Si falla el arranque o la disponibilidad, restaura las imágenes y configuración
anteriores. **Las migraciones no se revierten automáticamente**: deben ser
compatibles con la versión anterior; una recuperación de datos requiere revisar
y restaurar el dump manualmente. No hay poda automática de estas copias: revisar
el espacio del servidor periódicamente. Una compilación o migración fallida
no sustituye los servicios que estaban corriendo.

Este flujo actualiza la demo existente (`APP_PROFILE=demo`); el primer despliegue
con perfil `production` sigue su procedimiento separado más abajo.

### Arranque local

```bash
pnpm demo:up      # construye la imagen, genera .env.demo con secretos aleatorios la primera vez,
                  # migra, siembra datos sintéticos, crea el bucket y su ciclo de vida, y arranca todo
pnpm demo:check   # salud y disponibilidad, puertos publicados, Swagger apagado, solo usuarios
                  # sintéticos, y una copia de seguridad restaurada con los mismos recuentos
pnpm demo:down    # detiene; DEMO_WIPE=1 pnpm demo:down también borra los volúmenes
```

- Corre como proyecto `tracop-demo` (`docker-compose.demo.yml`) y **nunca lee `.env`**: usa `.env.demo`, que `demo:up` genera con secretos aleatorios y permisos `600`, y que git ignora.
- **Solo se publican la API y el S3 público** en `DEMO_BIND` (por defecto `127.0.0.1`): la API en `DEMO_API_PORT` (3100) y el S3 en `DEMO_S3_PORT` (9100). PostgreSQL, el trabajador y la consola de MinIO quedan dentro de la red de compose.
- **Códigos OTP:**
  - Se leen con `docker compose -f docker-compose.demo.yml --env-file .env.demo exec api cat /run/tracop-otp/codes.jsonl`.
  - Los escribe `OTP_SENDER=demo_capture` en un tmpfs privado del contenedor, nunca en los logs.
  - Ese sender solo arranca con `APP_PROFILE=demo`.
- **Recorrido completo por HTTP:** `pnpm demo:smoke`, explicado en [LIVE-WALKTHROUGH.md](LIVE-WALKTHROUGH.md).
- Usuarios sintéticos del seed: `+57300000000{01..07}`, uno por rol.

## Vitrina de la sustentación

El despliegue de AWS siembra la vitrina (31 cuentas suspendidas con lotes, pedidos y pagos) solo si falta, al final de cada despliegue y en cada `docker compose up`. Con `SHOWCASE_SEED=off` se desactiva. Ver [SHOWCASE.md](SHOWCASE.md).

## Imagen

`Dockerfile` en tres etapas sobre `node:22.23.1-bookworm-slim`: construcción, dependencias de producción y ejecución. La etapa final copia solo `dist/`, `drizzle/` y las dependencias de producción (sin `jest`, `tsx`, `drizzle-kit` ni `eslint`), corre como el usuario `node`, nunca como root, y no contiene secretos: todo llega por el entorno. La misma imagen sirve para:

| Proceso     | Comando                                                                 |
| ----------- | ----------------------------------------------------------------------- |
| API         | `node dist/main.js` (puerto 3000)                                       |
| Trabajador  | `node dist/worker.js` (uno o más; latido en `shared.worker_heartbeats`) |
| Migraciones | `node dist/drizzle/migrate.js`, antes de cada versión                   |

`APP_VERSION` (por defecto `0.0.0-dev`) se pasa como argumento de construcción y queda en la etiqueta `org.opencontainers.image.version`: `docker inspect` dice qué versión está desplegada.

## HTTPS sobre una demo AWS existente

`docker-compose.edge.yml` añade Caddy a la red `tracop-aws_default` sin recrear la API, el trabajador ni PostgreSQL. Requiere el registro DNS apuntando a la instancia y los puertos TCP 80/443 abiertos en su grupo de seguridad. El puerto 3100 sigue disponible para los clientes ya distribuidos.

En un directorio separado del servidor, copiar `Caddyfile` y `docker-compose.edge.yml`, y crear un `.env` con permisos `600`:

```dotenv
TRACOP_DOMAIN=tracop.duckdns.org
TRACOP_BACKEND_NETWORK=tracop-aws_default
```

```bash
docker compose -f docker-compose.edge.yml run --rm --no-deps caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker compose -f docker-compose.edge.yml up -d
curl --fail https://tracop.duckdns.org/ready
```

Mientras el puerto 3100 siga público, conservar `TRUST_PROXY=false`: así una conexión directa no puede falsificar su IP con cabeceras reenviadas. En esta demo las solicitudes HTTPS comparten la IP del proxy para los límites. En producción, publicar solo 80/443 y usar `TRUST_PROXY=1`. Para retirar únicamente el proxy, ejecutar `docker compose -f docker-compose.edge.yml down` sin `--volumes`; los datos de la aplicación y los certificados se conservan. Si cambia la IP pública, actualizar DuckDNS.

La imagen compila también el seed y la configuración del ciclo de vida: los servicios `setup` de las demos ejecutan `node dist/drizzle/migrate.js`, `node dist/drizzle/seed.js` y, en la demo con MinIO, `node dist/scripts/configure-storage-lifecycle.js`. No necesitan descargar `tsx` en el servidor.

## Proveedor de IA

La configuración admite `LLM_PROVIDER=anthropic` o `LLM_PROVIDER=google` ([ADR-023](adr/ADR-023.md)). Con Gemini se necesita una clave de Google AI Studio en `LLM_API_KEY` y un modelo explícito en `LLM_MODEL`; `LLM_BASE_URL` puede quedar vacío para usar el endpoint oficial. `AI_ENABLED=false` mantiene el asistente en el formulario guiado sin llamadas al proveedor.

La configuración de producción exige además `MIGRATION_DATABASE_URL` y versiones legales aprobadas. No cambiar `v0-draft` por una versión ficticia para superar la validación. El archivo externo `envToDeploy.md` anterior a ADR-023 necesita actualizar su proveedor y completar los valores vacíos antes de usarse; no es prueba de que esas variables estén instaladas en el servidor.

## Roles de base de datos

Producción separa quién puede cambiar el esquema de quién solo escribe filas:

| Rol            | Lo usa                              | Privilegios                                                                                 |
| -------------- | ----------------------------------- | ------------------------------------------------------------------------------------------- |
| `tracop_owner` | Solo el ejecutor de migraciones     | Dueño de los schemas; crea tablas, índices y triggers. Sin `SUPERUSER`.                     |
| `tracop_app`   | API y trabajador                    | `USAGE` en los schemas; `SELECT`, `INSERT`, `UPDATE` y `DELETE` en las tablas y secuencias. |
| `tracop_app`   | pg-boss, dentro de su propio schema | Dueño de `pgboss` y `CREATE` sobre la base, porque instala su schema al arrancar.           |

- `apps/api/scripts/provision-db-roles.ts` crea los dos roles y fija sus contraseñas desde `DB_OWNER_PASSWORD` y `DB_APP_PASSWORD`; usa las variables libpq (`PGHOST`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`) de la conexión de superusuario, no una URL, porque una contraseña en base64 necesitaría codificarse dentro de ella. Es idempotente.
- `drizzle/0032_database_roles.sql` concede los privilegios y los aplica también a las tablas futuras (`ALTER DEFAULT PRIVILEGES`). No crea roles, así que no guarda secretos y es inofensiva en desarrollo y en la demo, donde los roles no existen.
- La API y el trabajador usan `DATABASE_URL` (`tracop_app`); las migraciones usan `MIGRATION_DATABASE_URL` (`tracop_owner`). En producción `env.ts` exige la segunda, para que nadie despliegue con un solo rol.

## Producción (lista de comprobación)

1. **PostgreSQL 16 gestionado**, con TLS. `DATABASE_URL` con el rol `tracop_app` y `MIGRATION_DATABASE_URL` con `tracop_owner` (ver «Roles de base de datos»).
2. **Secretos** en el gestor de secretos de la plataforma, nunca en el repositorio ni en la imagen:
   - `JWT_SECRET`, `OTP_HMAC_SECRET` y `RATE_LIMIT_HMAC_SECRET`, de 32 bytes o más;
   - `TELEGRAM_BOT_TOKEN` y `TELEGRAM_WEBHOOK_SECRET`;
   - las claves `S3_API_*` y `S3_POLICY_*`, con los permisos mínimos de `.env.example`;
   - `METRICS_TOKEN`;
   - `LLM_API_KEY`, solo si `AI_ENABLED=true`.
3. **Rotación de secretos:**
   - `JWT_SECRET` cierra todas las sesiones; hay que avisar antes.
   - `OTP_HMAC_SECRET` invalida los OTP en curso.
   - `RATE_LIMIT_HMAC_SECRET` reinicia los contadores e invalida los seudónimos de los registros expirados. Conviene rotarlo solo ante una filtración.
   - Las claves de S3 y de Telegram se rotan en su proveedor y luego se reinicia.
4. **Despliegue en orden:**
   1. Migrar: las migraciones van solo hacia adelante.
   2. Desplegar la API, que debe responder `GET /ready`.
   3. Desplegar el trabajador.
   4. `pnpm telegram:set-webhook`, que registra `message` y `callback_query`.
   5. `pnpm storage:configure-lifecycle`.
   6. `pnpm storage:configure-cors` si el S3 lo admite.

### Secuencia con `docker-compose.prod.yml`

1. Copiar al servidor `docker-compose.prod.yml`, `Caddyfile` y `scripts/backup/`, y crear `.env` con permisos `600` fuera del repositorio:
   - `TRACOP_DOMAIN` con el dominio público de la API; Caddy no arranca sin él.
   - `DB_SUPERUSER_PASSWORD`, `DB_OWNER_PASSWORD` y `DB_APP_PASSWORD` con `openssl rand -hex 32` cada una. Hex y no base64: las contraseñas van dentro de `DATABASE_URL` y `MIGRATION_DATABASE_URL`, y un `+` o `/` exigiría codificarlas.
   - `DATABASE_URL=postgres://tracop_app:<app>@db:5432/tracop` y `MIGRATION_DATABASE_URL=postgres://tracop_owner:<owner>@db:5432/tracop`.
   - `BACKUP_S3_URI` y las claves `BACKUP_S3_*` de un usuario que solo pueda escribir en el bucket de copias.
2. `docker compose -f docker-compose.prod.yml run --rm migrate`: crea o rota los dos roles y aplica las migraciones como `tracop_owner`. Es idempotente.
3. `docker compose -f docker-compose.prod.yml up -d --wait`: base, migración, API, trabajador, Caddy y las copias. `GET /ready` responde `database` y `worker` en `ok`.
4. Cada versión: `PUBLIC_URL=https://api.<dominio> SSH_HOST=<host> SSH_USER=<usuario> ./scripts/deploy/deploy.sh v0.1.0`. El script toma una copia previa, descarga la imagen, migra, arranca y verifica `/health` y `/ready` en la URL pública.
5. **Comprobaciones:**
   - el balanceador usa `GET /health` como comprobación de vida y `GET /ready` como disponibilidad;
   - Prometheus raspa `GET /metrics` con `Authorization: Bearer <METRICS_TOKEN>`.
6. **`TRUST_PROXY`** según el proxy de la plataforma, para que el límite por IP y el HMAC del audit log vean la IP real.

## Una sola instancia de la API (piloto)

El piloto se despliega con **una sola instancia de la API**. Puede haber uno o más trabajadores.

### Límites de tasa en memoria

Estos límites viven en la memoria de cada proceso. Con N instancias, cada una aplica el límite por su cuenta y el límite real se multiplica por N:

- búsqueda (`CATALOG_SEARCH_RATE_LIMIT`);
- push y pull de sync (`SYNC_*_RATE_LIMIT`);
- pedidos (`ORDER_RATE_LIMIT`);
- propuestas de producto y subida de fotos (`CATALOG_PRODUCT_PROPOSAL_RATE_LIMIT`, `CATALOG_PHOTO_UPLOAD_RATE_LIMIT`);
- lecturas de ubicación (`LOGISTICS_LOCATION_RATE_LIMIT`);
- confianza (`TRUST_*_RATE_LIMIT`);
- recomendaciones (`RECOMMENDATIONS_RATE_LIMIT`);
- IA por minuto (`AI_REQUESTS_PER_MINUTE`);
- Telegram, por remitente y global (`TELEGRAM_RATE_LIMIT_*`).

Los límites del OTP (`identity.rate_limit_counters`), el límite diario de IA y el tope mensual de tokens están en PostgreSQL. Esos se comparten entre instancias.

### Antes de escalar a más instancias

Llevar los límites en memoria a PostgreSQL (como el OTP) o a la plataforma: el balanceador o un WAF.

### Por qué una instancia basta en el piloto

La prueba de carga (`docs/LOAD-TEST.md`) mide lo que aguanta una instancia en la máquina de desarrollo. Ese número no es una garantía de producción.

## Alarma de tamaño de las tablas de sync

`sync.change_log` y `sync.processed_operations` crecen sin límite: no hay compactación, ver [SYNC-RETENTION.md](SYNC-RETENTION.md). Una tarea programada de la plataforma, por ejemplo diaria, debe ejecutar:

```sql
SELECT relname AS tabla,
       n_live_tup AS filas_aprox,
       pg_size_pretty(pg_total_relation_size(relid)) AS tamano,
       pg_total_relation_size(relid) AS bytes
FROM pg_stat_user_tables
WHERE schemaname = 'sync' AND relname IN ('change_log', 'processed_operations');
```

Debe avisar al operador cuando cualquiera de las dos supere `SYNC_TABLE_ALERT_BYTES`, que es solo de la tarea y no lo lee la API.

- **Valor propuesto:** 1 GiB, PROVISIONAL. El equipo debe fijarlo según el disco del PostgreSQL gestionado.
- **Ritmo de referencia:** la prueba de carga escribe una fila de `change_log` por cada lote creado o cambiado, y una de `processed_operations` por cada operación de push.

Si se alcanza el umbral, hay que implementar la compactación diseñada en [SYNC-RETENTION.md](SYNC-RETENTION.md). Borrar filas a mano rompe los cursores y la idempotencia.

## Copias de seguridad

- **Programadas:** en la demo, el servicio `backup` ejecuta `scripts/backup/pg-backup.sh` al arrancar y cada `BACKUP_INTERVAL_SECONDS` (86 400 s). El script hace `pg_dump --format=custom` y escribe en `./backups`, conservando las `BACKUP_KEEP` (7) copias más recientes. En producción, `docker-compose.prod.yml` usa el mismo script cada 6 h y añade el servicio `backup-upload`, que sincroniza los volcados a un bucket privado aparte con `scripts/backup/s3-upload-loop.sh`.
  - El bucket de copias (`tracop-backups-<sufijo>`) tiene cifrado del lado del servidor y una regla de ciclo de vida que borra a los 30 días.
  - Las credenciales del servicio (`BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_KEY` y `BACKUP_S3_URI`, por ejemplo `s3://tracop-backups-xxxx/prod`) pertenecen a un usuario IAM que solo puede escribir en ese bucket: `s3:PutObject` sobre `arn:aws:s3:::<bucket>/*`. No puede listar, leer ni borrar.
  - `aws s3 sync` omite lo que ya está subido, así que cada ciclo cuesta una petición `HEAD` por archivo.
- **Prueba de restauración:**
  - `pnpm backup:restore-check <archivo.dump>` restaura la copia en un PostgreSQL 16 desechable y muestra los recuentos; con `SOURCE_COUNTS`, falla si no coinciden con el origen.
  - `pnpm demo:check` lo hace con una copia recién tomada.
  - En CI, `test/backup-restore.spec.ts` restaura un volcado de la base migrada y comprueba las migraciones, los datos, que la secuencia de `server_seq` continúa y que los triggers append-only siguen activos.
- **Recuperación:**

  1. Detener la API y el trabajador.
  2. `pg_restore --no-owner --exit-on-error -d <base vacía> <archivo.dump>`.
  3. `npx tsx drizzle/migrate.ts`, que no aplica nada si la copia ya es de esa versión.
  4. Arrancar.
  5. Comprobar `GET /ready`.

  Las operaciones de sync posteriores a la copia se pierden; los clientes las reenvían desde su outbox, y la idempotencia por `opId` evita duplicados.

## NO verificado

- El despliegue en una plataforma real: PostgreSQL gestionado, balanceador, gestor de secretos y S3 de producción.
- El cron de copias en producción y la copia fuera del servidor: `scripts/backup/s3-upload-loop.sh` está escrito pero NO verificado contra un bucket de AWS.
