/**
 * Stepped load test of the three hot paths: lot search, sync push and sync pull. Self-contained:
 * it starts a disposable PostgreSQL 16 (Testcontainers), applies the migrations, seeds synthetic
 * data, boots the API in this process on a free port and drives it over HTTP. Never touches .env
 * or a real database. Rate limits are raised for the run (they would otherwise be what is measured).
 *
 * For every step of active lots it saves the EXPLAIN (ANALYZE, BUFFERS) of the main search query,
 * then runs every step of concurrent users against search, push and pull, and reports p50/p95/p99,
 * throughput and errors. A step is acceptable when p95 ≤ LOAD_P95_MS and there are no errors.
 *
 *   pnpm --filter @tracop/api load:test                  # manual; refuses CI=true
 *   pnpm --filter @tracop/api load:test -- --smoke       # tiny run, allowed in CI (wiring only)
 *
 *   LOAD_LOT_STEPS (1000,5000,10000) · LOAD_USER_STEPS (10,50,100) · LOAD_REQUESTS_PER_USER (10)
 *   LOAD_P95_MS (500, PROVISIONAL) · LOAD_OUTPUT (JSON report path)
 */
import { randomUUID } from 'node:crypto';
import { cpus, totalmem } from 'node:os';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { createId as uuidv7 } from '../src/shared/kernel/ids.js';

const SMOKE = process.argv.includes('--smoke');
const list = (name: string, fallback: string) =>
  (process.env[name] ?? fallback)
    .split(',')
    .map(Number)
    .filter((value) => Number.isInteger(value) && value > 0)
    .sort((left, right) => left - right);
const LOT_STEPS = SMOKE ? [50] : list('LOAD_LOT_STEPS', '1000,5000,10000');
const USER_STEPS = SMOKE ? [2] : list('LOAD_USER_STEPS', '10,50,100');
const REQUESTS_PER_USER = SMOKE ? 2 : Number(process.env.LOAD_REQUESTS_PER_USER ?? 10);
/** PROVISIONAL: acceptable p95 for an interactive request; not a production guarantee. */
const P95_MS = Number(process.env.LOAD_P95_MS ?? 500);
const PUSH_BATCH_SIZE = 10;
const SUPPLIERS = 10;

type Sample = { readonly ms: number; readonly ok: boolean; readonly status: number };
type Measurement = {
  readonly path: 'search' | 'push' | 'pull';
  readonly lots: number;
  readonly users: number;
  readonly requests: number;
  readonly requestsPerSecond: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
  readonly errors: number;
  readonly statuses: Record<string, number>;
  readonly acceptable: boolean;
};

const round = (value: number) => Math.round(value * 10) / 10;

const measure = (
  path: Measurement['path'],
  lots: number,
  users: number,
  samples: readonly Sample[],
  elapsedMs: number,
): Measurement => {
  const sorted = samples.map(({ ms }) => ms).sort((left, right) => left - right);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const errors = samples.filter(({ ok }) => !ok).length;
  // Every user holds a valid session: a 401 means the instrument broke, not the API.
  if (samples.some(({ status }) => status === 401))
    throw new Error(`${path} with ${lots} lots and ${users} users got 401: the run is invalid`);
  const p95 = round(at(0.95));
  return {
    path,
    lots,
    users,
    requests: samples.length,
    requestsPerSecond: round(samples.length / (elapsedMs / 1000)),
    p50: round(at(0.5)),
    p95,
    p99: round(at(0.99)),
    max: round(sorted.at(-1) ?? 0),
    errors,
    statuses: samples.reduce<Record<string, number>>(
      (counts, { status }) => ({ ...counts, [status]: (counts[status] ?? 0) + 1 }),
      {},
    ),
    acceptable: errors === 0 && p95 <= P95_MS,
  };
};

const timed = async (operation: () => Promise<Response>): Promise<Sample> => {
  const startedAt = performance.now();
  try {
    const response = await operation();
    await response.arrayBuffer();
    return {
      ms: performance.now() - startedAt,
      ok: response.status < 400,
      status: response.status,
    };
  } catch {
    return { ms: performance.now() - startedAt, ok: false, status: 0 };
  }
};

/** Runs `requests` sequential calls per user, all users at once; returns samples and wall time. */
const drive = async (
  users: number,
  requests: number,
  call: (user: number, index: number) => Promise<Response>,
) => {
  const samples: Sample[] = [];
  const startedAt = performance.now();
  await Promise.all(
    Array.from({ length: users }, async (_, user) => {
      for (let index = 0; index < requests; index += 1)
        samples.push(await timed(() => call(user, index)));
    }),
  );
  return { samples, elapsedMs: performance.now() - startedAt };
};

/** The SQL of DrizzleLotRepository.findVisible, the query every search starts from. */
const SEARCH_SQL = `
  SELECT l.*, ((l.quantity * 1000 - COALESCE((SELECT SUM(r.quantity_milli) FROM catalog.lot_reservations r
      WHERE r.lot_id = l.id AND (r.status = 'consumed' OR (r.status = 'active' AND (r.expires_at IS NULL OR r.expires_at >= now())))), 0))::bigint)::text AS available_milli
  FROM catalog.lots l
  WHERE l.status IN ('published', 'reserved') AND l.available_until >= now() AND l.deleted_at IS NULL
    AND l.quantity * 1000 > COALESCE((SELECT SUM(r.quantity_milli) FROM catalog.lot_reservations r
      WHERE r.lot_id = l.id AND (r.status = 'consumed' OR (r.status = 'active' AND (r.expires_at IS NULL OR r.expires_at >= now())))), 0)
  ORDER BY l.available_from, l.id`;

const main = async (): Promise<void> => {
  if (process.env.CI === 'true' && !SMOKE)
    throw new Error('load:test is a manual measurement; only --smoke runs in CI.');
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const databaseUrl = container.getConnectionUri();
  const pool = new pg.Pool({ connectionString: databaseUrl });
  // The container is stopped at the end; idle connections then error out harmlessly.
  pool.on('error', () => undefined);
  try {
    await pool.query('CREATE SCHEMA IF NOT EXISTS shared');
    await pool.query(
      'CREATE TABLE IF NOT EXISTS shared.schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    for (const file of (await readdir(resolve('drizzle')))
      .filter((name) => /^\d+.*\.sql$/.test(name))
      .sort()) {
      await pool.query(await readFile(resolve('drizzle', file), 'utf8'));
      await pool.query('INSERT INTO shared.schema_migrations (id) VALUES ($1)', [file]);
    }

    Object.assign(process.env, {
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl,
      JWT_SECRET: 'load-test-jwt-secret-not-for-real-use-0000000',
      OTP_HMAC_SECRET: 'load-test-otp-hmac-secret-not-for-real-use-0',
      RATE_LIMIT_HMAC_SECRET: 'load-test-rate-limit-secret-not-for-real-00',
      OTP_SENDER: 'console',
      TELEGRAM_MODE: 'webhook',
      CATALOG_SEARCH_RATE_LIMIT: '1000000',
      SYNC_PUSH_RATE_LIMIT: '1000000',
      SYNC_PULL_RATE_LIMIT: '1000000',
      OTP_IP_REQUEST_LIMIT: '100000',
      OTP_IP_VERIFY_LIMIT: '100000',
      // Long runs outlast the 15 min access token: an expired session would be measured as 401.
      ACCESS_TOKEN_TTL_SECONDS: '86400',
    });
    const { Test } = await import('@nestjs/testing');
    const { AppModule } = await import('../src/bootstrap/app.module.js');
    const { configureHttp } = await import('../src/bootstrap/http.js');
    const { InMemoryOtpSender } =
      await import('../src/modules/identity/adapters/out/otp-senders.js');
    const { OTP_SENDER } = await import('../src/modules/identity/ports/tokens.js');
    const otp = new InMemoryOtpSender();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(OTP_SENDER)
      .useValue(otp)
      .compile();
    const app = moduleRef.createNestApplication({ bodyParser: false, logger: false });
    configureHttp(app, 256 * 1024);
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as { port: number };
    const base = `http://127.0.0.1:${address.port}`;
    const request = (path: string, token: string, body?: unknown) =>
      fetch(`${base}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    // Accounts are created one at a time: concurrent OTPs to the in-memory sender would mix codes.
    let phone = 3_150_000_000;
    const account = async (role: 'buyer' | 'supplier') => {
      const number = String(phone++);
      const deviceId = uuidv7();
      await post('/auth/register', {
        phone: number,
        role,
        fullName: 'Persona sintética',
        deviceId,
        platform: 'web',
        consent: { accepted: true, version: 'v0-draft' },
      });
      const verified = await post('/auth/otp/verify', {
        phone: number,
        deviceId,
        platform: 'web',
        code: [...otp.sent].reverse().find((sent) => sent.phone.endsWith(number))?.code,
      });
      const body = (await verified.json()) as { accessToken: string; user: { id: string } };
      return { token: body.accessToken, userId: body.user.id };
    };

    const categoryId = randomUUID();
    await pool.query(
      `INSERT INTO catalog.categories (id, name, parent_id, depth, created_at, updated_at) VALUES ($1, 'Tubérculos', NULL, 1, now(), now())`,
      [categoryId],
    );
    const products: string[] = [];
    for (const name of ['Papa criolla', 'Papa pastusa', 'Arracacha']) {
      const id = randomUUID();
      products.push(id);
      await pool.query(
        `INSERT INTO catalog.products (id, category_id, name, search_text, unit, attributes, created_at, updated_at) VALUES ($1, $2, $3, lower($3), 'kg', '{}', now(), now())`,
        [id, categoryId, name],
      );
    }
    const maxUsers = USER_STEPS.at(-1)!;
    const suppliers: { token: string; userId: string }[] = [];
    for (let index = 0; index < Math.max(SUPPLIERS, maxUsers); index += 1) {
      const supplier = await account('supplier');
      // Publishing requires a provider profile; the seeded lots need one too.
      await fetch(`${base}/me/provider-profile`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${supplier.token}` },
        body: JSON.stringify({
          displayName: 'Finca sintética',
          municipality: 'Tunja',
          department: 'Boyacá',
          lat: 5.53,
          lng: -73.36,
          description: 'Sintético',
        }),
      });
      suppliers.push(supplier);
    }
    const buyers: { token: string; userId: string }[] = [];
    for (let index = 0; index < maxUsers; index += 1) buyers.push(await account('buyer'));
    const owners = suppliers.slice(0, SUPPLIERS).map(({ userId }) => userId);

    const queries = [
      '/lots?q=papa&limit=20',
      '/lots?q=papa&lat=4.65&lng=-74.08&radiusKm=50&sort=distance&limit=20',
      '/lots?limit=50',
    ];
    const measurements: Measurement[] = [];
    const plans: { lots: number; executionMs: number; plan: string }[] = [];
    let seeded = 0;
    for (const lots of LOT_STEPS) {
      // Tops the catalog up to this step: published lots plus their owner-restricted sync changes.
      await pool.query(
        `WITH inserted AS (
           INSERT INTO catalog.lots (id, provider_id, product_id, quantity, unit, unit_price, available_from, available_until,
             location_lat, location_lng, status, version, created_at, updated_at)
           SELECT gen_random_uuid(), ($1::uuid[])[1 + (i % $2)], ($3::uuid[])[1 + (i % 3)], 100, 'kg', 2000 + (i % 500),
             now() - interval '1 hour', now() + interval '20 days', 4.5 + (i % 100) / 100.0, -74.2 + (i % 100) / 100.0,
             'published', 1, now(), now()
           FROM generate_series($4::int + 1, $5::int) AS i
           RETURNING id, provider_id)
         INSERT INTO sync.change_log (entity, entity_id, op, payload, owner_user_id, occurred_at)
         SELECT 'lot', id, 'upsert', jsonb_build_object('id', id), provider_id, now() FROM inserted`,
        [owners, owners.length, products, seeded, lots],
      );
      seeded = lots;
      await pool.query(
        'ANALYZE catalog.lots; ANALYZE catalog.lot_reservations; ANALYZE sync.change_log',
      );
      const explained = await pool.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${SEARCH_SQL}`,
      );
      const plan = explained.rows.map((row) => row['QUERY PLAN']).join('\n');
      plans.push({
        lots,
        executionMs: Number(/Execution Time: ([\d.]+) ms/.exec(plan)?.[1] ?? Number.NaN),
        plan,
      });

      for (const users of USER_STEPS) {
        const search = await drive(users, REQUESTS_PER_USER, (user, index) =>
          request(queries[(user + index) % queries.length]!, buyers[user]!.token),
        );
        measurements.push(measure('search', lots, users, search.samples, search.elapsedMs));

        const pull = await drive(users, REQUESTS_PER_USER, (user, index) =>
          // Half the users read as owners of seeded lots, half as buyers who see none of them.
          request(
            `/sync/pull?cursor=0&limit=200`,
            (index % 2 === 0 ? suppliers[user % SUPPLIERS]! : buyers[user]!).token,
          ),
        );
        measurements.push(measure('pull', lots, users, pull.samples, pull.elapsedMs));

        const push = await drive(users, REQUESTS_PER_USER, (user) => {
          const operations = Array.from({ length: PUSH_BATCH_SIZE }, (_, index) => {
            const id = uuidv7();
            return {
              opId: uuidv7(),
              entity: 'lot',
              entityId: id,
              type: 'create',
              payload: {
                id,
                productId: products[index % products.length],
                quantityMilli: '10000',
                unit: 'kg',
                unitPrice: 2400,
                qualityGrade: null,
                availableFrom: new Date().toISOString(),
                availableUntil: new Date(Date.now() + 86_400_000).toISOString(),
                locationLat: 5.5,
                locationLng: -73.4,
              },
            };
          });
          return request('/sync/push', suppliers[user]!.token, { operations });
        });
        measurements.push(measure('push', lots, users, push.samples, push.elapsedMs));
      }
    }

    const sizes = await pool.query<{ table: string; rows: string; bytes: string }>(
      `SELECT t.name AS table, t.rows::text AS rows, pg_total_relation_size(t.relation)::text AS bytes
       FROM (VALUES ('catalog.lots', 'catalog.lots'::regclass, (SELECT count(*) FROM catalog.lots)),
                    ('sync.change_log', 'sync.change_log'::regclass, (SELECT count(*) FROM sync.change_log)),
                    ('sync.processed_operations', 'sync.processed_operations'::regclass,
                     (SELECT count(*) FROM sync.processed_operations))) AS t(name, relation, rows)`,
    );
    const report = {
      machine: {
        cpu: cpus()[0]?.model ?? 'unknown',
        cores: cpus().length,
        memoryGiB: Math.round(totalmem() / 2 ** 30),
        node: process.version,
        database: 'PostgreSQL 16 (Testcontainers, same machine), API pool of 10 connections',
      },
      p95ThresholdMs: P95_MS,
      requestsPerUser: REQUESTS_PER_USER,
      smoke: SMOKE,
      measurements,
      plans,
      tables: sizes.rows,
    };
    if (process.env.LOAD_OUTPUT)
      await writeFile(process.env.LOAD_OUTPUT, JSON.stringify(report, null, 2) + '\n');

    const lines = [
      `${report.machine.cpu} · ${report.machine.cores} cores · ${report.machine.memoryGiB} GiB · Node ${process.version}`,
      `p95 threshold ${P95_MS} ms (PROVISIONAL) · ${REQUESTS_PER_USER} requests per user`,
      'path    lots    users  req/s   p50     p95     p99     errors  ok',
      ...measurements.map((m) =>
        [
          m.path.padEnd(7),
          String(m.lots).padEnd(7),
          String(m.users).padEnd(6),
          String(m.requestsPerSecond).padEnd(7),
          String(m.p50).padEnd(7),
          String(m.p95).padEnd(7),
          String(m.p99).padEnd(7),
          String(m.errors).padEnd(7),
          m.acceptable ? 'yes' : 'NO',
        ].join(' '),
      ),
      ...plans.map((plan) => `EXPLAIN search query with ${plan.lots} lots: ${plan.executionMs} ms`),
    ];
    process.stdout.write(lines.join('\n') + '\n');
    await app.close();
  } catch (error) {
    process.stderr.write(
      `load:test step failed: ${error instanceof Error ? `${error.name}: ${error.message}` : 'Error'}\n`,
    );
    process.exitCode = 1;
  } finally {
    await pool.end();
    await container.stop();
  }
};

main().catch((error: unknown) => {
  process.stderr.write(`load:test failed: ${error instanceof Error ? error.message : 'Error'}\n`);
  process.exit(1);
});
