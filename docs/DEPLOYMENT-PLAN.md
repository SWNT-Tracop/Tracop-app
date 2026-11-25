# Plan de despliegue del piloto

> **Estado:** propuesta.
>
> - Nada de esto se ha ejecutado, contratado ni configurado.
> - Los precios son estimaciones con fuente y fecha de consulta (2026-11-25). Lo que no se pudo confirmar en la página oficial del proveedor va marcado «NO verificado».
> - No contiene secretos.
> - Las decisiones que te tocan están en §15 «Preguntas», cada una con mi recomendación por defecto.

**Contexto:**

- Piloto pequeño: unas decenas de usuarios en Colombia.
- Presupuesto de estudiante y una sola persona operando.
- Hoy la API corre en local con un túnel para las demos.
- El primer entorno es **staging**, compartido con el equipo del móvil.

## 0. Resumen

|                                 | Recomendación para este piloto                                                                                                                                                                                                                           |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Dónde**                       | Opción **(a)**: un solo servidor **AWS Lightsail** en `us-east-1` (Virginia) con Docker Compose, más un bucket **Amazon S3** en la misma región.                                                                                                         |
| **Por qué**                     | Es la más barata que encaja con lo que el código ya necesita: S3 con POST prefirmado, `LISTEN` y advisory locks de PostgreSQL, un proceso trabajador continuo. Además, una sola persona la opera con los mismos comandos que la demo (`docker compose`). |
| **Coste estimado**              | De ~US$13 a ~US$25 al mes, más el dominio (§12).                                                                                                                                                                                                         |
| **Primero**                     | Solo staging, con datos sintéticos y un bot de pruebas. Producción, cuando el equipo del móvil tenga un cliente estable.                                                                                                                                 |
| **Antes del primer despliegue** | Cuatro cambios pequeños de código (§3.2), cada uno con su PR y sus pruebas.                                                                                                                                                                              |
| **Guía paso a paso en AWS**     | [Anexo A](#anexo-a-paso-a-paso-en-aws).                                                                                                                                                                                                                  |

## 1. Opciones comparadas

### Requisitos del código que descartan opciones

Salen del código y de las pruebas de las fases 1 a 11:

1. **Almacenamiento con POST prefirmado y política de tamaño y tipo** ([ADR-011](adr/ADR-011.md), `createPresignedPost`).
   - **Cloudflare R2 no lo admite:** un POST prefirmado responde `501 NotImplemented`, según el [issue de PostHog](https://github.com/PostHog/posthog/issues/102187) y la [comunidad de Cloudflare](https://community.cloudflare.com/t/problem-with-settings-cors-policies-on-r2/432339?page=2).
   - Usar R2 exigiría cambiar la subida a PUT y validar el tamaño en el servidor. Sería un cambio de diseño, no de configuración.
   - MinIO, ya probado, y **Amazon S3** sí lo admiten.
2. **PostgreSQL con conexión de sesión.**
   - El código usa `LISTEN`: la bandeja del asistente lo escucha en `postgres-notification-listener.ts`. También usa advisory locks.
   - Un _pooler_ en modo transacción (PgBouncer) rompe ambas cosas. Si la base gestionada impone un pooler, hay que usar su conexión **directa** o en modo sesión.
3. **Un proceso trabajador siempre encendido.** Corre los trabajos periódicos y el outbox con pg-boss, y deja un latido que `/ready` comprueba. Las plataformas que duermen los servicios sin tráfico no sirven para él.
4. **Una sola instancia de la API.** Los límites de tasa viven en memoria ([DEPLOYMENT.md](DEPLOYMENT.md)). No hace falta autoescalado.
5. **Webhook HTTPS para Telegram** en los puertos 443, 80, 88 u 8443 ([guía oficial](https://core.telegram.org/bots/webhooks)).

### Comparativa

|                             | **(a) Un servidor con Docker Compose**                                                                                                                                                                           | **(b) PaaS + base gestionada + S3**                                                                                                                                                                               | **(c) Infraestructura de la universidad**                                                                         |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Ejemplo concreto**        | AWS Lightsail, 2 o 4 GB, en `us-east-1`. Corren `caddy` (TLS automático), `api`, `worker`, `db` (PostgreSQL 16) y `backup`. El S3 es real.                                                                       | Render: API como _web service_, trabajador como _background worker_ y Render Postgres. S3 de AWS para los archivos.                                                                                               | Una máquina virtual en el centro de datos de la universidad.                                                      |
| **Coste/mes**               | Lightsail 2 GB: **US$12** con IPv4 ([AWS docs](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-bundles.html)). 4 GB: ~US$24, NO verificado. S3: menos de US$1 con unos pocos GB.         | API US$7 + trabajador US$7 + Postgres US$6 a US$19, sin plan de workspace ([fuentes de terceros](https://deployhandbook.com/pricing/render), **NO verificado** en render.com). Más S3. Total: **~US$20 a US$33**. | Desconocido; posiblemente US$0.                                                                                   |
| **Operación**               | Media. Tú actualizas el sistema, Docker y las copias, todo con los mismos `docker compose` de la demo.                                                                                                           | Baja. La plataforma parchea, reinicia y guarda las copias de la base.                                                                                                                                             | Depende de TI de la universidad: cuentas, firewall, VPN, horarios.                                                |
| **Latencia desde Colombia** | `us-east-1`: ~70 a 100 ms ([medición pública desde el Eje Cafetero](https://dev.to/dcastillogi/aws-local-zone-en-bogota-latencia-y-costos-frente-a-virginia-ohio-y-sao-paulo-325g)). NO verificado desde Bogotá. | Similar si la región es Virginia u Ohio. NO verificado.                                                                                                                                                           | Probablemente la mejor, si está en Bogotá. NO verificado.                                                         |
| **Riesgos**                 | Punto único de fallo: si cae la máquina, cae todo. Disco lleno. Copias mal configuradas.                                                                                                                         | Más piezas, cada una con su facturación. Pooler o límites de conexiones de la base. Coste que crece por servicio.                                                                                                 | IP pública, HTTPS y apertura de puertos sin garantía. Mantenimientos sin aviso. Uso comercial quizá no permitido. |
| **Si falla**                | Restauras la copia en una instancia nueva: RTO objetivo de 2 h (§4.6). Los clientes reenvían sus operaciones de sync.                                                                                            | Reinicio automático. La base tiene copias del proveedor.                                                                                                                                                          | Depende de TI.                                                                                                    |
| **Para este piloto**        | **Recomendada.** La más barata que cumple los requisitos, y tú ya la conoces por la demo.                                                                                                                        | Buena si prefieres pagar ~US$10 más al mes a cambio de no operar el sistema operativo.                                                                                                                            | Solo si TI confirma por escrito IP pública, HTTPS, puertos 80 y 443, copias y permiso de uso. Pregunta 3.         |

### Opciones descartadas

- **Hetzner:** en EE. UU. solo vende planes CPX y CCX tras las subidas de 2026. El CPX21 en Ashburn cuesta ~US$37/mes ([1](https://devshot.co/blog/hetzner-cloud-pricing), [2](https://bitdoze.com/hetzner-cloud-cost-optimized-plans/), NO verificado). Los planes baratos están en Europa, con más latencia. NO verificado.
- **DigitalOcean:** el droplet de 2 GB cuesta US$12 y la base gestionada desde US$15 ([fuente de terceros](https://actualdatabase.com/digitalocean-droplets-price-per-month/), NO verificado). Es equivalente a (a); elijo AWS por S3 en la misma red y por los créditos del plan gratuito.
- **AWS «completo»** (EC2, RDS, ALB): RDS `db.t4g.micro` ~US$11,68 + 20 GB gp3 ~US$2,30 ([CloudRoute](https://www.cloudroutehq.com/aws/rds-pricing), NO verificado en aws.amazon.com), más EC2, más IPv4 a US$0,005/h ≈ US$3,65 ([AWS](https://aws.amazon.com/blogs/aws/new-aws-public-ipv4-address-charge-public-ip-insights/)). El balanceador costaría ~US$18 más. Es más caro y más trabajo para una persona. Queda como paso siguiente (§14, fase 4).
- **Zona local de AWS en Bogotá:** existe ([AWS](https://aws.amazon.com/blogs/publicsector/aws-announces-local-zones-latin-america)), pero no confirmé qué servicios ofrece, y Lightsail no corre allí. Su latencia es la mejor, pero exige EC2 y VPC: más complejo.

**Créditos de AWS:** las cuentas nuevas desde el 15-07-2025 reciben US$100 en créditos y pueden ganar hasta US$100 más, durante 6 meses ([AWS](https://aws.amazon.com/about-aws/whats-new/2025/07/aws-free-tier-credits-month-free-plan/)). Que Lightsail se pueda pagar con esos créditos en el plan gratuito está NO verificado; se confirma al crear la cuenta.

## 2. Entornos

|                                | **staging** (fase 1)                                                                                                                                                                           | **production** (fase 3)                  |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| **Para qué**                   | El equipo del móvil integra; ensayo con 3 usuarios de confianza.                                                                                                                               | El piloto con datos reales.              |
| **`APP_PROFILE` / `NODE_ENV`** | `production` / `production`. Con eso, staging valida lo mismo que producción: Telegram, HTTPS, S3 y secretos fuertes. La demo no sirve para staging: su OTP solo se lee dentro del contenedor. | `production` / `production`.             |
| **Dominio**                    | `api-staging.<dominio>`                                                                                                                                                                        | `api.<dominio>`                          |
| **Datos**                      | Sintéticos, más la taxonomía real del piloto cuando esté decidida (§11).                                                                                                                       | Reales.                                  |
| **Bot de Telegram**            | `@<nombre>_staging_bot`, de pruebas.                                                                                                                                                           | `@<nombre>_bot`, solo para producción.   |
| **Bucket S3**                  | `tracop-staging-<sufijo>`                                                                                                                                                                      | `tracop-prod-<sufijo>`                   |
| **Secretos**                   | Propios, generados aparte.                                                                                                                                                                     | Propios. **Nunca** se copian de staging. |
| **Base de datos**              | Propia.                                                                                                                                                                                        | Propia.                                  |

- **Al inicio, un solo entorno:** solo staging. Mientras no haya cliente móvil en producción, un segundo entorno duplica el coste y la operación sin dar nada.
- **Ubicación de producción:** cuando exista, irá en **otra instancia**, para separar fallos y datos. Ponerla en la misma solo se justifica si el presupuesto obliga (pregunta 2).
- **Separación:** nada se comparte entre entornos (variables, secretos, dominio, bucket, base de datos ni bot). Cada uno tiene su archivo `/opt/tracop/<entorno>/.env`, con permisos `600` y fuera del repositorio.

## 3. Empaquetado

### 3.1 Lo que ya existe

- **`Dockerfile`:**
  - Dos etapas sobre `node:22.23.1-bookworm-slim`.
  - Corre como el usuario `node`, sin secretos en la imagen.
  - Una sola imagen sirve para la API (`node dist/main.js`), el trabajador (`node dist/worker.js`) y las migraciones (`npx tsx drizzle/migrate.ts`).
- **sharp y libvips funcionan en la imagen final:** `pnpm demo:smoke` sube una foto, la recodifica a WebP dentro del contenedor y la sirve. Pasó 3 de 3 veces en la fase 11.

### 3.2 Cambios necesarios antes de desplegar

Son cambios de código, cada uno en un PR con sus pruebas; **no** forman parte de este plan:

1. **Imagen sin dependencias de desarrollo.**
   - Hoy la etapa final copia todo `/app` de la etapa de construcción, incluidas las devDependencies. Resultado: **842 MB** (`docker images tracop-api:demo`).
   - **Propuesta:** `pnpm deploy --prod` a una carpeta aparte, y copiar a la imagen final solo `dist/`, `drizzle/` y las dependencias de producción.
2. **Migraciones sin `tsx`.** El ejecutor `drizzle/migrate.ts` necesita `tsx`, que es una dependencia de desarrollo. Se puede compilar `migrate.ts` a `dist/drizzle/migrate.js` o pasar `tsx` a dependencias de producción. Lo primero es más limpio.
3. **Proxy delante de la API.** `docker-compose.prod.yml` debe incluir **Caddy** (TLS automático con Let's Encrypt) delante de la API, con tiempos máximos (`read_body`, `read_header`, `write`, `idle`). Así se cierra la deuda 12 sin tocar la API.
4. **Etiqueta de versión en la imagen** (`org.opencontainers.image.version`) y un `GET /health` que devuelva la versión, para saber qué está desplegado.

**Pendiente:** confirmar el tamaño de la imagen tras el cambio 1 y que sharp sigue funcionando. `demo:smoke` lo cubre.

## 4. Base de datos

### 4.1 Alojamiento y versión

- **Dónde:** PostgreSQL **16** (la misma versión de CI y de las pruebas) en el contenedor `db` del servidor, con su volumen en el disco de la instancia. Sin puerto publicado: solo es accesible desde la red de Compose.
- **Alternativa gestionada:** Lightsail Managed Database desde US$15/mes ([fuente de terceros](https://cloudburn.io/blog/amazon-lightsail-pricing), NO verificado) o RDS (§1). Con ella se ahorran las copias y los parches, a cambio de más coste. Pregunta 4.

### 4.2 Usuarios con privilegios mínimos

Hoy todo usa un único `DATABASE_URL`. Propuesta de tres roles:

| Rol                        | Lo usa                                                                    | Privilegios                                                                                                                 | Por qué                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `tracop_owner`             | Solo el ejecutor de migraciones (`drizzle/migrate.ts`), antes de arrancar | Dueño de los schemas de los módulos (`identity`, `catalog`, …, `shared`). Crea tablas, índices y triggers. Sin `SUPERUSER`. | Las migraciones hacen DDL. La API no debe poder hacerlo.                                                                      |
| `tracop_app`               | API y trabajador                                                          | `USAGE` en los schemas; `SELECT`, `INSERT`, `UPDATE` y `DELETE` en las tablas; `USAGE` en las secuencias. Sin DDL.          | Los triggers append-only siguen protegiendo `audit_log`, el ledger y los consentimientos aunque la API tenga `DELETE`.        |
| pg-boss (con `tracop_app`) | Trabajador                                                                | **Dueño del schema `pgboss`**, creado de antemano por `tracop_owner`.                                                       | pg-boss crea y migra sus propias tablas al arrancar (`pg-boss-job-scheduler.ts`). Necesita DDL, pero solo dentro de `pgboss`. |

- **Implementación:** una migración nueva que cree los roles y los `GRANT`, más privilegios por defecto (`ALTER DEFAULT PRIVILEGES`) para las tablas futuras.
- **Pendiente de verificar:** que los triggers y funciones existentes no necesiten `SECURITY DEFINER` ni privilegios del dueño.
- **Pruebas:** la suite e2e completa con `tracop_app` como usuario.

### 4.3 Conexiones y pool

- **Conexiones previstas:** la API abre un pool de **10** (`database.ts:78`, fijo). El trabajador abre otro de 10 y pg-boss el suyo, unas 10 por defecto (NO verificado para su versión). En total, ~30 con un trabajador, frente al `max_connections` de 100 de PostgreSQL. Alcanza de sobra.
- **Fuera de los límites:** la prueba de carga (fase 11) ya muestra que el pool no es el cuello de botella, sino la CPU de la búsqueda.
- **Modo de conexión:** siempre directa o en modo sesión (§1, requisito 2).

### 4.4 Migraciones

1. **Orden:** migrar con `tracop_owner`, luego arrancar la API y por último el trabajador. Así lo deja escrito [DEPLOYMENT.md](DEPLOYMENT.md).
2. **Compatibles hacia atrás** (_expand → contract_).
   - Una versión solo **añade**: columnas nulas o con valor por defecto, tablas, índices `CONCURRENTLY` si la tabla es grande.
   - Lo que quita o renombra va en una versión posterior, cuando ningún código antiguo lo use.
   - Así, revertir la imagen (§10) funciona sin revertir el esquema.
3. **Si una migración falla:**
   - Cada archivo corre en su propia transacción (`migrate.ts`). Un fallo hace `ROLLBACK` de ese archivo y no registra nada en `shared.schema_migrations`.
   - El despliegue se detiene antes de arrancar la nueva API, y la versión anterior sigue funcionando.
   - Se corrige con una migración **nueva**: nunca se edita una ya aplicada.
4. **Copia previa:** antes de cada migración se toma una copia (`pg-backup.sh`).

### 4.5 Copias

- **Programación:** el servicio `backup` (ya existe) ejecuta `pg_dump --format=custom` cada **6 h**. Hoy es cada 24 h en la demo; el valor PROVISIONAL de producción es 6 h.
- **Dónde se guardan:**
  - en el disco del servidor, las últimas 7;
  - **subidas a un bucket S3 privado aparte** (`tracop-backups-<sufijo>`), con cifrado del lado del servidor y una regla de ciclo de vida que borra a los **30 días** (PROVISIONAL).
  - La subida necesita un script pequeño con `aws s3 cp` y credenciales que solo puedan escribir en ese bucket.
- **Instantánea del disco:** una instantánea automática diaria de Lightsail como segunda copia ([precio de instantáneas US$0,05/GB-mes](https://cloudburn.io/blog/amazon-lightsail-pricing), NO verificado).
- **Prueba de restauración:**
  - **Mensual**, con `pnpm backup:restore-check <copia>`, que ya existe y compara los recuentos.
  - Además, **una restauración completa en una instancia nueva antes del piloto** (§14, fase 2).

### 4.6 RPO y RTO

|                                          | Objetivo (PROVISIONAL) | Cómo se logra                                                                                                                                                                                                 |
| ---------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **RPO**, datos que se pueden perder      | **6 h**                | Copias cada 6 h. Las operaciones de sync posteriores las reenvía la outbox del móvil (idempotente por `opId`). Pagos y pedidos son solo en línea: lo perdido se recupera de los comprobantes y del audit log. |
| **RTO**, tiempo hasta volver a funcionar | **2 h**                | Instancia nueva, `docker compose up`, restaurar la última copia y repuntar el DNS. Se cronometra en el ensayo de la fase 2.                                                                                   |

## 5. Almacenamiento S3

- **Proveedor:** **Amazon S3**, en `us-east-1` como la instancia.
  - Precio: US$0,023/GB-mes y US$0,005 por cada 1 000 PUT o POST ([fuente de terceros](https://filebase.com/blog/aws-s3-pricing-in-2026-what-youll-actually-pay/), NO verificado en aws.amazon.com/s3/pricing).
  - Con fotos WebP de cientos de KB, el piloto usa menos de 5 GB: menos de US$1/mes.
- **Buckets:** uno por entorno, privados, con «Block Public Access» activado. Nunca se sirve nada en público: las descargas usan URL firmadas.
- **Tres credenciales separadas** (usuarios o roles IAM):

  | Credencial                        | Variables                                             | Permisos mínimos                                                                   |
  | --------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------- |
  | API (servidor)                    | `S3_API_ACCESS_KEY` / `S3_API_SECRET_KEY`             | `s3:GetObject`, `s3:PutObject` y `s3:DeleteObject` sobre `arn:aws:s3:::<bucket>/*` |
  | Firma de POST (cliente)           | `S3_POLICY_ACCESS_KEY` / `S3_POLICY_SECRET_KEY`       | Solo `s3:PutObject` en los prefijos `incoming/*` y `payment-incoming/*`            |
  | Administrador (ejecución puntual) | Solo en tu máquina, al ejecutar `storage:configure-*` | `s3:PutBucketCORS` y `s3:PutLifecycleConfiguration` sobre el bucket                |

- **HTTPS:** `S3_ENDPOINT=https://s3.us-east-1.amazonaws.com`. `env.ts` exige HTTPS en producción.
- **CORS:** `pnpm storage:configure-cors` con **solo** los orígenes reales del móvil y del backoffice. Una app nativa no necesita CORS; un cliente web, sí.
- **Ciclo de vida:** `pnpm storage:configure-lifecycle` expira `incoming/` y `payment-incoming/` a las 24 h.
- **Prueba pendiente contra el servicio real (deuda 2):**
  1. Ejecutar `pnpm storage:configure-cors` y `storage:configure-lifecycle` contra el bucket de staging.
  2. Correr `pnpm demo:smoke` adaptado a staging: subir una foto y un comprobante, y descargarlos con URL firmada.
  3. Comprobar que la credencial de POST **no** puede leer ni borrar.

## 6. Red y seguridad

- **Puertos:**
  - Solo **80** y **443** abiertos a Internet en el firewall de Lightsail. El 80 sirve para el desafío de TLS y redirige a 443.
  - **SSH (22)** solo desde tu IP, o cerrado y con acceso por la consola web de Lightsail.
  - PostgreSQL sin puerto publicado.
- **TLS:** Caddy obtiene y renueva solo los certificados de Let's Encrypt. Alerta: certificado a menos de 14 días de caducar (§9).
- **Cabeceras:** las pone la API (helmet, fase 9). Caddy no las duplica.
- **`TRUST_PROXY=1`:** hay exactamente un proxy, Caddy, delante de la API. Sin ese valor, el límite por IP y el HMAC de IP del audit log verían la IP de Caddy. Hay que comprobar con una petición que `X-Forwarded-For` llega bien.
- **Tiempos máximos:** se fijan en Caddy (§3.2, punto 3).
- **Gestión de secretos:**
  - **Dónde viven:** el `.env` del entorno en el servidor (`600`, propietario `root`), generado con `openssl rand -base64 48`.
  - **Copia de los secretos:** en tu gestor de contraseñas (Bitwarden o 1Password), con acceso solo tuyo. **Nunca** en el repositorio, en chats ni en tickets.
  - **Alternativa AWS:** Parameter Store, cuyos parámetros estándar no cuestan nada ([fuente de terceros](https://infisical.com/blog/aws-secrets-manager-vs-parameter-store)), frente a los US$0,40 por secreto de Secrets Manager.
- **Rotación:**
  - Cómo rotar cada secreto y qué efecto tiene: [DEPLOYMENT.md](DEPLOYMENT.md).
  - **Ensayo** en staging antes del piloto (§14, fase 2): rotar `JWT_SECRET` y comprobar que las sesiones se cierran y se puede volver a entrar; rotar la clave de S3 y comprobar que las subidas siguen funcionando.
- **Acceso:**
  - Cuenta raíz de AWS con MFA y sin claves de acceso.
  - Un usuario IAM para ti, con MFA.
  - SSH solo con clave, sin contraseña ni acceso de `root`.
- **Actualizaciones:**
  - `unattended-upgrades` para los parches de seguridad del sistema.
  - Una vez al mes: `docker compose pull` de las imágenes base y reconstruir.
  - Dependabot, con la configuración propuesta en la fase 11.

## 7. Telegram

- **Bots separados:** uno de **producción** y otro de **staging**, creados en BotFather. El token de producción solo vive en el `.env` de producción.
- **Webhook:**
  - Se registra con `pnpm telegram:set-webhook https://api.<dominio>/webhooks/telegram`, con `TELEGRAM_WEBHOOK_SECRET` de 32 caracteres o más (lo exige #75).
  - Telegram lo envía en la cabecera `X-Telegram-Bot-Api-Secret-Token` ([guía](https://core.telegram.org/bots/webhooks)), y el webhook lo verifica.
- **Si el webhook falla:**
  - Telegram guarda los updates y reintenta; el tiempo de retención está NO verificado.
  - La idempotencia por `update_id` evita procesar un update dos veces.
  - Diagnóstico: `getWebhookInfo` muestra `last_error_message` y `pending_update_count`. Es la alerta del §9.
  - El polling solo está permitido en desarrollo (`env.ts`), así que no es una alternativa en producción.
- **OTP por Telegram:**
  - Obliga al usuario a vincular antes el chat.
  - Para el piloto real, la decisión pendiente es pasar a **SMS o WhatsApp** (§23.7). Los dos tienen coste por mensaje.
  - El código ya tiene `OtpSenderPort`: es un adaptador nuevo, no un cambio de dominio. Pregunta 7.

## 8. IA

**Se despliega con `AI_ENABLED=false`**, el valor por defecto. Antes de activarla:

1. **Texto legal:** el aviso de privacidad y el aviso de IA, aprobados por el equipo, con su versión (§23.9). Pasos:
   - poner `PRIVACY_POLICY_VERSION` y `AI_CONSENT_VERSION` con un valor distinto de `v0-draft`;
   - hoy producción acepta `v0-draft` (deuda 13). Propongo un PR pequeño que lo rechace en producción.
2. **Clave del proveedor:** una clave de API propia del entorno, en un **workspace** separado de la consola de Anthropic.
3. **Tope de gasto:** un límite mensual del workspace en la consola ([docs](https://platform.claude.com/docs/en/api/rate-limits)). Además, el tope interno `AI_MONTHLY_TOKEN_CAP`, que ya existe, y el límite diario por usuario.
4. **Evaluación:** `pnpm ai:eval-live` con el modelo elegido (`LLM_MODEL`), que ejecutas tú. Objetivo: 90 % o más de los campos (PROVISIONAL).
5. **Si el proveedor cae, es lento o se agota el tope:** el asistente ya pasa al formulario guiado sin IA (fase 7, probado). No hay que hacer nada; solo se ve en las métricas (§9).

## 9. Observabilidad

### Logs

- **Dónde:** los de Docker (pino en JSON) se ven con `docker compose logs`, con rotación (`max-size: 10m`, `max-file: 5`).
- **PII:** las líneas no llevan PII; ya está probado desde la fase 9.
- **Centralización (opcional):** un servicio con plan gratuito, por ejemplo Grafana Cloud. Sus límites están NO verificados.

### Métricas

`GET /metrics` con `METRICS_TOKEN`:

- **Fase 1:** sin Prometheus. Un `cron` en el servidor lo lee cada 5 min y avisa si algo supera un umbral. Así se ahorra un servicio.
- **Más adelante:** Prometheus o Grafana Agent.

### Alertas mínimas

| Alerta                              | Cómo                                                                                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Caída de la API                     | **UptimeRobot**, plan gratuito: 50 monitores cada 5 min ([UptimeRobot](https://uptimerobot.com/pricing/)). Vigila `https://api.<dominio>/health`. |
| Caída del trabajador                | UptimeRobot sobre `/ready`, que responde **503** si el último latido tiene más de `READY_WORKER_MAX_AGE_SECONDS`.                                 |
| Cola del outbox o trabajos fallidos | `cron` con `pnpm outbox:status`: avisa si hay eventos en cola de fallidos o pendientes de más de 10 min.                                          |
| Errores 5xx                         | `cron` sobre `/metrics`: avisa si el contador de 5xx sube en 5 min.                                                                               |
| Disco                               | `cron` con `df`: avisa por encima del 80 %.                                                                                                       |
| Tablas de sync                      | La consulta de [DEPLOYMENT.md](DEPLOYMENT.md), a diario, con `SYNC_TABLE_ALERT_BYTES`.                                                            |
| Webhook de Telegram                 | `cron` con `getWebhookInfo`: avisa si `pending_update_count` > 50 o hay un `last_error_date` reciente.                                            |
| Certificado TLS                     | Monitor de certificado de UptimeRobot, si el plan gratuito lo incluye (NO verificado), o un `cron` con `openssl`.                                 |
| Coste de IA                         | Alertas del workspace de Anthropic.                                                                                                               |
| Coste de AWS                        | **AWS Budgets**, con aviso al 50 %, 80 % y 100 % del tope (§12).                                                                                  |

Todos los avisos llegan a **un solo canal**: un chat privado de Telegram contigo, enviado por un bot de alertas distinto del de los usuarios, o un correo.

### El lunes por la mañana (5 minutos)

1. ¿Hubo correos o mensajes de alerta durante el fin de semana?
2. `docker compose ps`: los cinco servicios están `running` o `healthy`.
3. `pnpm outbox:status`: 0 eventos fallidos.
4. Que haya copias de las últimas 24 h, en el servidor y en el bucket de copias.
5. Gasto de AWS y de la IA en lo que va del mes.

## 10. CI/CD

1. **Ramas:**
   - `develop` integra el trabajo de cada fase.
   - **`main` es lo desplegable**: el PR #35 pasa `develop` a `main`.
   - Se despliega desde **etiquetas** creadas sobre `main`: `v0.1.0`, `v0.1.1`…
2. **Construcción:** un workflow nuevo, `release.yml`, que corre con cada etiqueta `v*`:
   - pasa los mismos pasos de `ci.yml`;
   - construye la imagen y la publica en **GitHub Container Registry** (`ghcr.io/swnt-tracop/tracop-api:v0.1.0`). Es gratuito para repositorios públicos (NO verificado para el plan de la organización). La imagen no contiene secretos.
   - Las acciones van fijadas por SHA, como en el resto (`ci-workflow.spec.ts`).
3. **Despliegue con aprobación manual:** un job `deploy`, con `environment: production` y **revisor obligatorio**, que hace:
   1. SSH al servidor con una clave dedicada, guardada como secreto del environment;
   2. copia previa de la base;
   3. migración;
   4. `docker compose up -d` con la nueva etiqueta;
   5. comprobación de `/health` y `/ready`.

   Si cualquier paso falla, se detiene.

   **Alternativa más simple:** el mismo script `scripts/deploy/deploy.sh v0.1.0`, ejecutado a mano por SSH.

4. **Rollback documentado y probado:**
   1. `deploy.sh v0.1.0-anterior` vuelve a la imagen anterior. Funciona porque las migraciones son _expand-only_ (§4.4).
   2. Si una migración corrompió datos, se restaura la copia tomada justo antes (§4.5).
   3. Se **ensaya en staging** en la fase 2: desplegar `v0.1.1`, volver a `v0.1.0` y verificar con `demo:smoke` adaptado.
5. **Versión del contrato:** cada etiqueta publica `docs/openapi.json` como adjunto del release. El equipo del móvil integra contra una etiqueta, no contra `develop`.

## 11. Datos del piloto

- **Carga inicial:**
  - **Taxonomía y productos reales** del corredor piloto: los decides tú (§23.5), no son sintéticos.
  - Se cargan con la API del personal (`POST /catalog/categories` y `POST /catalog/products`), que deja audit log. Propongo un script que lea un CSV revisado por ti.
  - `pnpm db:seed` **no** se usa fuera de `development` y `demo`; ya lo impide el código.
- **Personal:** `pnpm identity:create-staff --phone … --name … --role …`, ejecutado una vez por persona dentro del contenedor. Al inicio: un `admin` (tú), un `operator` y un `finance`.
- **Datos de prueba frente a datos reales:**
  - Staging: siempre sintéticos (los teléfonos `+57300000000xx` del seed o los del equipo).
  - Producción: solo reales. Nunca se copian datos de producción a staging.
- **Retención y borrado:** según los parámetros PROVISIONALES de §23.13, que ya aplica el trabajador. Las solicitudes de supresión (Ley 1581) se atienden con el CLI o el procedimiento que defina el equipo (pregunta 9).
- **Lo que se entrega al equipo del móvil:**

  | Qué               | Valor                                                                        |
  | ----------------- | ---------------------------------------------------------------------------- |
  | URL base          | `https://api-staging.<dominio>`                                              |
  | Contrato          | `docs/openapi.json` de la etiqueta desplegada. Ojo: tiene huecos (deuda 11). |
  | CORS              | Solo si hay cliente web: los orígenes exactos que nos den.                   |
  | Bot de staging    | `@<nombre>_staging_bot`, para vincular el chat y recibir el OTP.             |
  | Cuentas de prueba | Teléfonos sintéticos del equipo, creados en staging.                         |
  | Límites           | Los valores de `.env` del entorno (límites de tasa, tamaño de fotos).        |

## 12. Costes y límites

Estimación mensual; los precios, en la tabla de §1.

| Servicio                    | Staging (fase 1)                                                                                                                                                                       | Con producción (fase 3)       | Nota                                                           |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------- |
| Lightsail 2 GB, `us-east-1` | US$12                                                                                                                                                                                  | US$12 + US$12 o US$24         | Producción quizá con 4 GB, NO verificado                       |
| Instantáneas de Lightsail   | ~US$1 a US$3                                                                                                                                                                           | ~US$2 a US$6                  | NO verificado                                                  |
| S3 (archivos y copias)      | menos de US$1                                                                                                                                                                          | ~US$1 a US$2                  |                                                                |
| Dominio `.co`               | ~US$15 a US$36 el primer año y ~US$31 a US$36 de renovación ([Dynadot](https://www.dynadot.com/es/dominio/co), [OVHcloud](https://www.ovhcloud.com/es/domains/tld/co/)), NO verificado | —                             | Un `.com` o un subdominio de la universidad puede costar menos |
| UptimeRobot                 | US$0                                                                                                                                                                                   | US$0                          | Plan gratuito                                                  |
| GitHub (Actions, GHCR)      | US$0                                                                                                                                                                                   | US$0                          | Repositorio público, NO verificado                             |
| IA (Anthropic)              | US$0 (apagada)                                                                                                                                                                         | Según el tope que fijes       | Pregunta 6                                                     |
| SMS o WhatsApp              | US$0                                                                                                                                                                                   | Por mensaje                   | Pregunta 7                                                     |
| **Total aproximado**        | **~US$13 a US$16**                                                                                                                                                                     | **~US$27 a US$45 + IA + SMS** | Sin IA ni SMS                                                  |

**Topes recomendados:**

- AWS Budgets en **US$25/mes** durante staging y **US$50/mes** con producción.
- Workspace de Anthropic en **US$10/mes** al empezar.
- Los créditos de AWS (§1) pueden cubrir los primeros meses.

**Si se acaba el presupuesto, se apaga en este orden:**

1. La IA (`AI_ENABLED=false`): el formulario guiado sigue funcionando.
2. Staging, cuando ya hay producción.
3. Las instantáneas: quedan las copias en S3.
4. Bajar producción a 2 GB.

La API, el trabajador, la base y las copias en S3 **nunca** se apagan.

## 13. Runbook de una página

Se ejecuta en el servidor, en `/opt/tracop/<entorno>`, con el archivo `docker-compose.prod.yml` (pendiente de crear, §3.2).

| Situación                                  | Qué hacer                                                                                                                                                                                                                                                         |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Arrancar**                               | `docker compose up -d`, y luego `curl -fs https://api.<dominio>/ready`                                                                                                                                                                                            |
| **Parar**                                  | `docker compose stop`. Los datos quedan en los volúmenes. **Nunca** `down -v`.                                                                                                                                                                                    |
| **Desplegar `vX`**                         | `scripts/deploy/deploy.sh vX`: copia, migración, arranque y comprobación                                                                                                                                                                                          |
| **Revertir**                               | `scripts/deploy/deploy.sh v<anterior>`. Si hubo daño en los datos, ir a «Restaurar».                                                                                                                                                                              |
| **Restaurar**                              | 1. `docker compose stop api worker`.<br>2. Restaurar en una base vacía con `pg_restore --no-owner --exit-on-error`.<br>3. Migrar.<br>4. `docker compose start api worker`.<br>5. Comprobar `/ready`.                                                              |
| **Rotar un secreto**                       | Editar el `.env` y ejecutar `docker compose up -d api worker`. El efecto de cada secreto está en [DEPLOYMENT.md](DEPLOYMENT.md). Para Telegram, además, `telegram:set-webhook`.                                                                                   |
| **La API no responde**                     | 1. `docker compose ps`.<br>2. `docker compose logs --tail 200 api`.<br>3. `df -h`.<br>4. Reiniciar con `docker compose restart api`.<br>5. Si la máquina no responde, reiniciarla desde la consola de Lightsail.<br>6. Si se perdió, crear una nueva y restaurar. |
| **El trabajador no late (`/ready` = 503)** | `docker compose logs --tail 200 worker`, `docker compose restart worker` y `pnpm outbox:status`                                                                                                                                                                   |
| **Avisar**                                 | Al equipo del móvil, por el canal que acordemos (pregunta 10), si la caída pasa de 15 min. A los usuarios del piloto, por el bot, si pasa de 1 h.                                                                                                                 |

## 14. Fases y criterios de salida

| Fase                                      | Contenido                                                                                                                                                     | Criterio de salida                                                                                                                                                                                                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0. Preparación**                        | Cambios de §3.2 (PR con pruebas), roles de base de datos (§4.2), `docker-compose.prod.yml` con Caddy, `release.yml` y `deploy.sh`. Tus tareas (§16).          | CI en verde; `demo:smoke` pasa con la imagen nueva; imagen de producción sin dependencias de desarrollo.                                                                                                                                                                          |
| **1. Staging listo**                      | Instancia, dominio, TLS, S3 real, bot de staging y alertas. Despliegue de `v0.1.0`.                                                                           | `/health` y `/ready` en verde por HTTPS. Recorrido completo con el bot real y un teléfono ([LIVE-WALKTHROUGH.md](LIVE-WALKTHROUGH.md)). Prueba de S3 real (§5). Alertas probadas (se apaga el trabajador a propósito y llega el aviso). El equipo del móvil tiene URL y contrato. |
| **2. Ensayo con 3 usuarios de confianza** | Un productor, un comprador y un transportista reales del equipo, en staging, durante 1 o 2 semanas. Ensayos de restauración, rollback y rotación de secretos. | Recorrido completo sin intervención manual. Restauración completa cronometrada (≤ 2 h). Rollback y rotación ensayados. Sin errores 5xx sin explicar. Textos legales aprobados.                                                                                                    |
| **3. Piloto**                             | Producción en su propia instancia, con taxonomía real y personal creado con el CLI. PR #35 a `main` y etiqueta `v1.0.0`.                                      | Lo deciden tú y el equipo: número de transacciones, usuarios activos, incidencias.                                                                                                                                                                                                |
| **4. Después** (fuera de este plan)       | Base gestionada (RDS), varias instancias con límites de tasa compartidos, búsqueda en SQL, SMS o WhatsApp.                                                    | —                                                                                                                                                                                                                                                                                 |

## 15. Preguntas para ti

Cada una lleva mi recomendación por defecto.

1. **¿AWS (Lightsail + S3) o Render + S3?** Recomiendo **Lightsail + S3**: es la más barata y opera igual que la demo.
2. **¿Producción en una instancia aparte o junto a staging?** Recomiendo **aparte** cuando haya producción. Al inicio, **solo staging**.
3. **¿La universidad ofrece una máquina con IP pública, HTTPS y permiso de uso?** Si no lo confirma TI por escrito, se descarta.
4. **¿PostgreSQL en el servidor o gestionado?** Recomiendo **en el servidor** durante el piloto, con copias a S3 cada 6 h y una prueba mensual de restauración.
5. **¿Qué dominio?** Recomiendo uno propio (`.co` o `.com`), con `api-staging.` y `api.` como subdominios. ¿Lo compras tú y me das acceso al DNS, o lo manejas tú?
6. **¿IA en el piloto y con qué tope mensual?** Recomiendo **apagada** hasta tener los textos legales. Después, un workspace con **US$10/mes**.
7. **¿OTP por Telegram en el piloto, o SMS/WhatsApp desde el inicio?** Recomiendo **Telegram en staging y en el ensayo**, y decidir el canal según el costo antes de la fase 3.
8. **¿RPO de 6 h y RTO de 2 h te sirven?** Son valores PROVISIONALES.
9. **¿Cómo se atiende una solicitud de supresión de datos (Ley 1581)?** Necesito el procedimiento del equipo; el código ya expira registros y aplica retenciones.
10. **¿Por qué canal se avisa al equipo del móvil de una caída, y quién más recibe las alertas?** Recomiendo un chat de Telegram del equipo.
11. **¿Cerramos el hueco del OpenAPI (deuda 11) antes de entregar staging al móvil?** Recomiendo **sí**, solo para las rutas que el móvil usará primero.
12. **¿Cuándo integramos el PR #35 (`develop` → `main`)?** Recomiendo al final de la fase 0, para que la primera etiqueta `v0.1.0` salga de `main`.

## 16. Lo que necesitas hacer tú

- [ ] **Crear la cuenta de AWS** a tu nombre o al del equipo:
  - MFA en la cuenta raíz y un usuario IAM para el día a día;
  - AWS Budgets con el tope de §12.
- [ ] **Comprar el dominio** y darme acceso al DNS, o crear tú los registros `A` que te indique.
- [ ] **Crear los bots** en BotFather: staging ahora, producción en la fase 3.
- [ ] **Generar y guardar los secretos** en tu gestor de contraseñas: el `.env` de cada entorno con valores de `openssl rand`. **No me los pases por el chat.** Los escribes tú en el servidor, o me das acceso a un gestor de secretos.
- [ ] **Textos legales:** el aviso de privacidad y el aviso de IA, aprobados y con su versión.
- [ ] **Datos reales del piloto:** la taxonomía y los productos del corredor, y las personas del personal.
- [ ] **Responder las preguntas de §15.**
- [ ] **Si habrá IA:** la cuenta y el workspace de Anthropic, con su límite de gasto.
- [ ] **Configurar GitHub:**
  - las protecciones de rama y `CODEOWNERS` (lista de la fase 11);
  - el environment `production` con tú como revisor.

---

## Anexo A. Paso a paso en AWS

**Arquitectura:**

- **1 instancia Lightsail** (Ubuntu LTS, 2 GB) en `us-east-1`, con Docker Compose. Corre:
  - `caddy` en los puertos 80 y 443;
  - `api` y `worker`;
  - `db` (PostgreSQL 16, sin puerto publicado);
  - `backup`.
- **Buckets de Amazon S3** en `us-east-1`: uno de archivos por entorno y uno de copias.
- **DNS** en tu registrador, o Route 53 (US$0,50 por zona al mes, NO verificado).

Cada paso dice qué se necesita y cómo se comprueba. Los pasos 1 a 3 los haces tú, porque tocan cuentas y dinero.

### 1. Cuenta y seguridad (tú)

1. Crear la cuenta de AWS y activar MFA en la cuenta raíz.
2. Crear un usuario IAM `tracop-admin` con MFA y usarlo siempre en lugar de la raíz.
3. Crear un presupuesto en **Billing → Budgets**: «Monthly cost budget», US$25, avisos al 50 %, 80 % y 100 % a tu correo.
4. Elegir la región **us-east-1 (N. Virginia)** y usarla en todo.

**Comprobación:** entras con `tracop-admin` y MFA, y el presupuesto aparece en Budgets.

### 2. Dominio (tú)

1. Comprar el dominio.
2. Crear, más adelante (paso 5), `api-staging.<dominio>` → IP estática de la instancia, registro `A`.

### 3. Buckets S3 y credenciales IAM

1. **S3 → Create bucket.**
   - Crear `tracop-staging-<sufijo>`: región `us-east-1`, **Block all public access** activado, cifrado SSE-S3 por defecto y versionado desactivado.
   - Repetir con `tracop-backups-<sufijo>` (para las copias), añadiéndole una regla de ciclo de vida «expire after 30 days».
2. **IAM → Policies.** Crear tres políticas, cada una limitada a su bucket (§5):
   - `tracop-staging-api`: `GetObject`, `PutObject` y `DeleteObject` sobre `arn:aws:s3:::tracop-staging-<sufijo>/*`.
   - `tracop-staging-post`: `PutObject` sobre `…/incoming/*` y `…/payment-incoming/*`.
   - `tracop-backups-writer`: `PutObject` sobre `arn:aws:s3:::tracop-backups-<sufijo>/*`.
3. **IAM → Users.** Crear tres usuarios sin acceso a la consola (`tracop-staging-api`, `tracop-staging-post`, `tracop-backups`), uno por política. Generar sus claves de acceso y guardarlas **directamente** en tu gestor de contraseñas.
4. Las tareas de administración del bucket (CORS y ciclo de vida) se hacen con tu usuario `tracop-admin` desde tu máquina, no con estas claves.

**Comprobación:** desde tu máquina, con la clave de `post`, `aws s3 ls s3://tracop-staging-<sufijo>` debe dar **AccessDenied**, porque esa clave no puede listar.

### 4. Instancia Lightsail

1. **Lightsail → Create instance:**
   - región `us-east-1`; plataforma Linux, **Ubuntu 24.04 LTS** o la LTS vigente;
   - plan de **2 GB** (US$12 con IPv4);
   - nombre `tracop-staging`;
   - activar las **instantáneas automáticas** diarias.
2. **Networking:**
   - crear una **IP estática** y asociarla, porque la IP de la instancia cambia al reiniciar;
   - en el **firewall IPv4**, dejar solo HTTP 80, HTTPS 443 y SSH 22 restringido a tu IP.
3. **Conectarse** por SSH con la clave que descargaste o con el navegador desde la consola, y preparar el sistema:

   ```bash
   sudo apt update && sudo apt -y upgrade && sudo apt -y install unattended-upgrades
   # Docker Engine y el plugin compose, desde el repositorio oficial de Docker (docs.docker.com/engine/install/ubuntu)
   sudo usermod -aG docker ubuntu        # cerrar sesión y volver a entrar
   sudo mkdir -p /opt/tracop/staging && sudo chown ubuntu /opt/tracop/staging
   ```

4. En `/etc/ssh/sshd_config`, poner `PasswordAuthentication no` y `PermitRootLogin no`, y luego `sudo systemctl restart ssh`.

**Comprobación:** `docker version` y `docker compose version` responden. Un `nmap` desde fuera solo ve los puertos 22, 80 y 443.

### 5. DNS y TLS

1. Crear en el registrador el registro `A`: `api-staging.<dominio>` → la IP estática.
2. Caddy, en el compose del paso 6, pide el certificado solo con una línea `api-staging.<dominio> { reverse_proxy api:3000 }`. Ahí van también los tiempos máximos.

**Comprobación:** `curl -I https://api-staging.<dominio>/health` responde `200` con un certificado válido.

### 6. Desplegar la aplicación

Requiere los cambios de §3.2: `docker-compose.prod.yml` con Caddy y la imagen publicada en GHCR.

1. En `/opt/tracop/staging`:
   - copiar `docker-compose.prod.yml` y el `Caddyfile`;
   - crear el `.env` (`chmod 600`) **escribiéndolo tú**, con los valores de tu gestor de contraseñas.

   | Grupo         | Variables                                                                                                                                                            |
   | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | Perfil        | `NODE_ENV=production`, `APP_PROFILE=production`, `TRUST_PROXY=1`                                                                                                     |
   | Base de datos | `DATABASE_URL` con `tracop_app`; `MIGRATION_DATABASE_URL` con `tracop_owner` (variable **nueva**, parte del cambio de §4.2: hoy las migraciones usan `DATABASE_URL`) |
   | Identidad     | `JWT_SECRET`, `OTP_HMAC_SECRET`, `RATE_LIMIT_HMAC_SECRET` (32 caracteres o más, distintos), `OTP_SENDER=telegram`, `PRIVACY_POLICY_VERSION`                          |
   | Telegram      | `TELEGRAM_MODE=webhook`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_BOT_USERNAME`                                                                    |
   | S3            | `S3_ENDPOINT=https://s3.us-east-1.amazonaws.com`, `S3_BUCKET`, `S3_REGION=us-east-1`, `S3_API_*`, `S3_POLICY_*`                                                      |
   | Operación     | `METRICS_TOKEN`, `CORS_ALLOWED_ORIGINS` (solo si hay cliente web), `AI_ENABLED=false`                                                                                |

2. Ejecutar:

   ```bash
   docker compose pull                                   # ghcr.io/swnt-tracop/tracop-api:v0.1.0
   docker compose up -d db && docker compose run --rm migrate   # servicio «migrate» del compose propuesto (§3.2): crea roles, schemas y tablas
   docker compose up -d api worker caddy backup
   ```

3. Configurar el bucket desde tu máquina, con `tracop-admin` y las variables del bucket de staging:
   - `pnpm storage:configure-lifecycle`;
   - `pnpm storage:configure-cors`, solo si hay orígenes web.
4. Crear el personal: `docker compose exec api node … create-staff --phone … --role admin`. El comando exacto depende del cambio 2 de §3.2.
5. Registrar el webhook: `pnpm telegram:set-webhook https://api-staging.<dominio>/webhooks/telegram`.

**Comprobación:**

- `https://api-staging.<dominio>/ready` responde `200`, lo que confirma la base y el latido del trabajador;
- `getWebhookInfo` no muestra errores;
- el recorrido de [LIVE-WALKTHROUGH.md](LIVE-WALKTHROUGH.md) funciona con el bot de staging y un teléfono.

### 7. Copias

1. En el compose, el servicio `backup` con `BACKUP_INTERVAL_SECONDS=21600` (6 h).
2. Un paso que suba cada copia a `s3://tracop-backups-<sufijo>/staging/` con la clave de `tracop-backups`.
3. **Prueba de restauración:** descargar la última copia en tu máquina y ejecutar `pnpm backup:restore-check <archivo>`. Debe mostrar los mismos recuentos.

**Comprobación:** hay una copia de las últimas 6 h en S3, y `restore-check` termina correctamente.

### 8. Alertas

1. Crear en **UptimeRobot** dos monitores HTTP cada 5 min: `https://api-staging.<dominio>/health` y `/ready`. Enviar los avisos a tu correo o a Telegram.
2. En el servidor, un `cron` con los chequeos de §9: outbox, disco, 5xx, webhook y tablas de sync. Todos avisan al mismo canal.
3. Probarlo: `docker compose stop worker`. En ≤ 10 min debe llegar el aviso de `/ready`. Luego, `docker compose start worker`.

### 9. Entregar al equipo del móvil

Entregar la URL, la etiqueta del contrato, el bot de staging y las cuentas de prueba (§11).

### 10. Producción (fase 3)

1. Repetir los pasos 3 a 8 con los nombres `prod`: otra instancia, otro bucket, otro bot, otros secretos y `api.<dominio>`.
2. Integrar el PR #35, crear la etiqueta `v1.0.0` y desplegarla con aprobación manual.

## Fuentes consultadas (2026-11-25)

- [Lightsail instance bundles (AWS docs)](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-bundles.html)
- [Lightsail pricing guide (cloudburn.io)](https://cloudburn.io/blog/amazon-lightsail-pricing)
- [Lightsail CORS de buckets (AWS docs)](https://docs.aws.amazon.com/lightsail/latest/userguide/configure-cors.html)
- [AWS Free Tier: créditos y plan de 6 meses (AWS)](https://aws.amazon.com/about-aws/whats-new/2025/07/aws-free-tier-credits-month-free-plan/)
- [Cargo por IPv4 pública (AWS blog)](https://aws.amazon.com/blogs/aws/new-aws-public-ipv4-address-charge-public-ip-insights/)
- [Precio de RDS (CloudRoute)](https://www.cloudroutehq.com/aws/rds-pricing)
- [Precio de S3 (Filebase)](https://filebase.com/blog/aws-s3-pricing-in-2026-what-youll-actually-pay/)
- [Parameter Store frente a Secrets Manager (Infisical)](https://infisical.com/blog/aws-secrets-manager-vs-parameter-store)
- [AWS Local Zones en Latinoamérica (AWS)](https://aws.amazon.com/blogs/publicsector/aws-announces-local-zones-latin-america)
- [Latencia desde Colombia a us-east-1 y sa-east-1 (DEV Community)](https://dev.to/dcastillogi/aws-local-zone-en-bogota-latencia-y-costos-frente-a-virginia-ohio-y-sao-paulo-325g)
- [Render pricing (Deploy Handbook)](https://deployhandbook.com/pricing/render)
- [Hetzner pricing 2026 (devshot)](https://devshot.co/blog/hetzner-cloud-pricing) y [bitdoze](https://bitdoze.com/hetzner-cloud-cost-optimized-plans/)
- [DigitalOcean droplets (actualdatabase)](https://actualdatabase.com/digitalocean-droplets-price-per-month/)
- [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [R2 sin POST prefirmado (PostHog)](https://github.com/PostHog/posthog/issues/102187) y [comunidad de Cloudflare](https://community.cloudflare.com/t/problem-with-settings-cors-policies-on-r2/432339?page=2)
- [Webhooks de Telegram (guía oficial)](https://core.telegram.org/bots/webhooks)
- [Límites de tasa y de gasto de la API de Claude](https://platform.claude.com/docs/en/api/rate-limits)
- [UptimeRobot pricing](https://uptimerobot.com/pricing/)
- Dominio `.co`: [Dynadot](https://www.dynadot.com/es/dominio/co) y [OVHcloud](https://www.ovhcloud.com/es/domains/tld/co/)
