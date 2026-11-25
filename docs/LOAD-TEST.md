# Prueba de carga por escalones

`pnpm --filter @tracop/api load:test`:

1. Levanta un PostgreSQL 16 desechable (Testcontainers), aplica las migraciones y siembra datos sintéticos.
2. Arranca la API en el mismo proceso.
3. Para cada escalón de lotes activos:
   - guarda el `EXPLAIN (ANALYZE, BUFFERS)` de la consulta con la que empieza toda búsqueda (`DrizzleLotRepository.findVisible`);
   - recorre cada escalón de usuarios concurrentes en búsqueda, pull y push de sync.

Notas de funcionamiento:

- No usa `.env` ni ninguna base real.
- Sube los límites de tasa y la vigencia del token para que no sean lo que se mida. Si aparece un 401, invalida la ejecución.
- Se niega a correr con `CI=true`. En CI solo corre `--smoke`, que prueba el instrumento (`apps/api/test/load-test-smoke.spec.ts`), no los números.

| Variable                 | Por defecto      | Qué es                                                          |
| ------------------------ | ---------------- | --------------------------------------------------------------- |
| `LOAD_LOT_STEPS`         | 1000,5000,10000  | Lotes publicados sembrados en cada escalón (acumulados)         |
| `LOAD_USER_STEPS`        | 10,50,100        | Usuarios concurrentes de cada escalón                           |
| `LOAD_REQUESTS_PER_USER` | 10               | Peticiones seguidas de cada usuario, por ruta                   |
| `LOAD_P95_MS`            | 500, PROVISIONAL | p95 aceptable; un escalón con errores nunca es aceptable        |
| `LOAD_OUTPUT`            | —                | Informe JSON con medidas, planes EXPLAIN y tamaño de las tablas |

Con 50 000 lotes, el escalón dura unos 20 minutos y se ejecuta a mano.

## Máquina de la medición (2026-11-25)

**No es una garantía de producción.**

- **Hardware y software:** portátil de desarrollo con AMD Ryzen 7 7435HS (16 hilos) y 23 GiB de RAM, Linux, Node v22.23.4.
- **Base de datos:** PostgreSQL 16 en Docker en la misma máquina.
- **Topología:** una sola instancia de la API, con el pool de 10 conexiones por defecto. El generador de carga corre en la misma máquina, y no hay red real.

### Órdenes ejecutadas

```bash
LOAD_LOT_STEPS=1000,10000,50000 LOAD_USER_STEPS=10,50,100,200 LOAD_REQUESTS_PER_USER=10 pnpm --filter @tracop/api load:test
# La primera ejecución pasó de 15 min: los tokens caducaron y el escalón de 50 000 lotes con
# 100 y 200 usuarios midió 401. Se corrigió el instrumento y se repitió ese escalón:
LOAD_LOT_STEPS=50000 LOAD_USER_STEPS=10,50,100,200 LOAD_REQUESTS_PER_USER=10 pnpm --filter @tracop/api load:test
```

## Resultados

p95 en milisegundos; «sí» significa p95 ≤ 500 ms y sin errores. No hubo ningún error en las filas que siguen.

| Lotes  | Usuarios | Búsqueda req/s | Búsqueda p95 | Pull req/s | Pull p95 | Push req/s (10 op) | Push p95   |
| ------ | -------- | -------------- | ------------ | ---------- | -------- | ------------------ | ---------- |
| 1 000  | 10       | 74,7           | 155,9 sí     | 604,1      | 25,6 sí  | 65,0               | 174,8 sí   |
| 1 000  | 50       | 74,3           | 816,4 no     | 669,6      | 97,3 sí  | 68,3               | 830,1 no   |
| 1 000  | 100      | 78,5           | 1 335,4 no   | 801,4      | 167,5 sí | 75,5               | 1 366,9 no |
| 1 000  | 200      | 80,1           | 2 563,2 no   | 811,9      | 317,5 sí | 76,0               | 2 704,6 no |
| 10 000 | 10       | 15,7           | 673,0 no     | 767,0      | 17,0 sí  | 70,5               | 167,7 sí   |
| 10 000 | 50       | 15,2           | 3 357,7 no   | 744,3      | 85,4 sí  | 74,9               | 691,5 no   |
| 10 000 | 100      | 15,0           | 6 891,3 no   | 771,4      | 171,3 sí | 75,6               | 1 362,1 no |
| 10 000 | 200      | 14,2           | 14 916,9 no  | 788,0      | 330,0 sí | 75,9               | 2 669,8 no |
| 50 000 | 10       | 3,2            | 3 263,7 no   | 598,6      | 26,5 sí  | 66,5               | 167,9 sí   |
| 50 000 | 50       | 3,1            | 16 916,2 no  | 769,7      | 83,1 sí  | 71,8               | 729,9 no   |
| 50 000 | 100      | 2,8            | 38 099,9 no  | 749,9      | 167,8 sí | 67,2               | 1 542,4 no |
| 50 000 | 200      | 2,3            | 88 261,0 no  | 721,4      | 391,9 sí | 70,9               | 3 152,2 no |

### EXPLAIN de la consulta de búsqueda

`findVisible` trae todos los lotes visibles, sin filtros ni límite:

| Lotes  | Tiempo de ejecución en PostgreSQL | Plan                                                                                                                    |
| ------ | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1 000  | 3,0 ms                            | Seq Scan + Sort en memoria                                                                                              |
| 10 000 | 30,1 ms                           | Bitmap Index Scan `lots_available_idx` + Sort                                                                           |
| 50 000 | 157,6 a 164,2 ms                  | Bitmap Index Scan `lots_available_idx` + Sort `external merge` en disco (7,5 MB); dos subconsultas de reservas por lote |

## Tope medido con p95 ≤ 500 ms

En esta máquina:

| Ruta     | Tope                                                                                                                                                     |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Búsqueda | 1 000 lotes: entre 10 y 50 usuarios concurrentes. Estimado, unos 35, con un techo de ~75 búsquedas/s. 10 000 lotes o más: ni siquiera 10 usuarios.       |
| Push     | Entre 10 y 50 usuarios concurrentes, sea cual sea el número de lotes. Estimado, unos 30, con un techo de ~70 peticiones/s, es decir, ~700 operaciones/s. |
| Pull     | 200 usuarios concurrentes con 50 000 lotes (p95 391,9 ms). No se alcanzó su límite.                                                                      |

## Qué se rompe primero y por qué

1. **La búsqueda, en cuanto crecen los lotes.**
   - Su rendimiento es inversamente proporcional al número de lotes visibles: 75 → 15 → 3 req/s.
   - Cada búsqueda carga todos los lotes visibles y los filtra, ordena y pagina en memoria ([ADR-010](adr/ADR-010.md)). Es trabajo de CPU en el único hilo de Node.
   - PostgreSQL solo pone de 3 a 164 ms por petición. A partir de ~16 000 filas, además, ordena en disco.
   - La latencia crece linealmente con los usuarios porque las peticiones esperan en el bucle de eventos.
   - **Arreglo cuando haga falta:** llevar filtros, orden y paginación por cursor a SQL (deuda 5 de la matriz).
2. **El push de sync, con concurrencia.**
   - El rendimiento se mantiene en ~70 peticiones/s con cualquier número de lotes: lo limita el lock global de secuencia del change log ([ADR-012](adr/ADR-012.md)), que serializa las escrituras.
   - La latencia crece con los usuarios que esperan ese lock.
3. **El pull no es cuello de botella** en los rangos medidos.

## Lectura para el piloto

El piloto es un corredor con pocos productos: cientos de lotes activos, no decenas de miles. Con menos de 1 000 lotes y unas decenas de usuarios concurrentes, una instancia queda por debajo de 500 ms de p95. Las condiciones de despliegue están en [DEPLOYMENT.md](DEPLOYMENT.md): una sola instancia y la alarma de tamaño de las tablas de sync.

## Tamaño de las tablas al final

Primera ejecución completa, incluido el escalón inválido:

- `catalog.lots`: 128 000 filas, 35 MB;
- `sync.change_log`: 128 000 filas, 56 MB;
- `sync.processed_operations`: 78 000 filas, 26 MB.

## NO verificado

- Red real.
- Hardware de producción.
- PostgreSQL gestionado.
- Varias instancias.
- Una mezcla de tráfico realista.
