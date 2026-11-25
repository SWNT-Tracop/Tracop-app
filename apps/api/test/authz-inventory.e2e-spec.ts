import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { RequestMethod } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type pg from 'pg';
import request from 'supertest';
import { AppModule } from '../src/bootstrap/app.module.js';
import { InMemoryOtpSender } from '../src/modules/identity/adapters/out/otp-senders.js';
import { OTP_SENDER } from '../src/modules/identity/ports/tokens.js';
import { AuthGuard } from '../src/shared/auth/auth-guard.js';
import { PUBLIC_ROUTE, REQUIRED_ROLES } from '../src/shared/auth/auth-metadata.js';
import { DATABASE_POOL } from '../src/shared/infra/tokens.js';
import { createId } from '../src/shared/kernel/ids.js';
import { formatMarkdown } from './helpers/markdown.js';
import { createStaffAccount } from './helpers/staff-account.js';
import { describePostgres, resetPostgresFixtures } from './postgres-suite.js';

const MATRIX_PATH = resolve(__dirname, '..', '..', '..', 'docs', 'AUTHZ-MATRIX.md');
const OPENAPI_PATH = resolve(__dirname, '..', '..', '..', 'docs', 'openapi.json');
const METRICS_TOKEN = 'authz-metrics-token-not-for-real-use-0123456789';
const ROLES = ['producer', 'supplier', 'buyer', 'carrier', 'operator', 'finance', 'admin'] as const;
type Role = (typeof ROLES)[number];

/** Routes deliberately outside the OpenAPI document, each with its own protection. */
const UNDOCUMENTED = new Map([
  ['GET /metrics', 'Bearer METRICS_TOKEN; 404 without it, so its existence is not revealed'],
  ['POST /webhooks/telegram', 'X-Telegram-Bot-Api-Secret-Token header'],
]);
/** Routes reachable without a user session, and the status an anonymous request gets here. */
const PUBLIC = new Map<string, number>([
  ['GET /health', 200],
  ['GET /ready', 503], // no worker heartbeat in this test
  ['GET /metrics', 404],
  // Generic answers: registering or asking for a code never reveals whether the phone exists.
  ['POST /auth/register', 201],
  ['POST /auth/otp/request', 201],
  ['POST /auth/otp/verify', 401],
  ['POST /auth/refresh', 401],
  ['POST /webhooks/telegram', 401],
]);

type Route = {
  readonly method: string;
  readonly path: string; // OpenAPI style: /lots/{id}
  readonly key: string;
  readonly public: boolean;
  readonly guarded: boolean;
  readonly roles: readonly string[] | null;
};

const join = (...parts: (string | undefined)[]) =>
  '/' +
  parts
    .flatMap((part) => (part ?? '').split('/'))
    .filter(Boolean)
    .map((segment) => (segment.startsWith(':') ? `{${segment.slice(1)}}` : segment))
    .join('/');

/** Every controller route of the running application, from Nest's own metadata. */
const controllerRoutes = (app: INestApplication): Route[] => {
  const routes: Route[] = [];
  for (const module of app.get(ModulesContainer).values())
    for (const wrapper of module.controllers.values()) {
      const type = wrapper.metatype as (new (...args: never[]) => unknown) | null;
      if (!type) continue;
      const classPath = Reflect.getMetadata(PATH_METADATA, type) as string | undefined;
      const classGuards = (Reflect.getMetadata(GUARDS_METADATA, type) ?? []) as unknown[];
      const prototype = type.prototype as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(prototype)) {
        const handler = prototype[name];
        if (name === 'constructor' || typeof handler !== 'function') continue;
        const methodPath = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
        if (methodPath === undefined || method === undefined) continue;
        const guards = [
          ...classGuards,
          ...((Reflect.getMetadata(GUARDS_METADATA, handler) ?? []) as unknown[]),
        ];
        const verb = RequestMethod[method]!;
        const path = join(classPath, methodPath);
        routes.push({
          method: verb,
          path,
          key: `${verb} ${path}`,
          public:
            Reflect.getMetadata(PUBLIC_ROUTE, handler) === true ||
            Reflect.getMetadata(PUBLIC_ROUTE, type) === true,
          guarded: guards.includes(AuthGuard),
          roles:
            (Reflect.getMetadata(REQUIRED_ROLES, handler) as string[] | undefined) ??
            (Reflect.getMetadata(REQUIRED_ROLES, type) as string[] | undefined) ??
            null,
        });
      }
    }
  return routes.sort((left, right) => left.key.localeCompare(right.key));
};

const PARAMS: Record<string, string> = { channel: 'telegram', key: 'order.freight_cop' };
const concrete = (path: string) =>
  path.replace(/\{(\w+)\}/g, (_, name: string) => PARAMS[name] ?? createId());

type Operation = {
  parameters?: { name: string; in: string; required?: boolean; schema?: { format?: string } }[];
  requestBody?: { content?: Record<string, { examples?: Record<string, { value: unknown }> }> };
};
/**
 * Bodies for operations whose OpenAPI entry has no example (or no requestBody at all), so the
 * call gets past validation to the authorization check in the application layer.
 */
const BODIES: Record<string, unknown> = {
  'POST /orders': {
    id: createId(),
    lines: [{ lotId: createId(), quantityMilli: '1000' }],
    deliveryAddress: 'Calle sintética 1, Bogotá',
  },
  'PATCH /catalog/categories/{id}': { name: 'Sintética' },
  'PATCH /catalog/products/{id}': {
    categoryId: createId(),
    name: 'Sintético',
    unit: 'kg',
    attributes: {},
  },
  'POST /catalog/product-proposals/{id}/reject': { rejectionReason: 'Sintético' },
  'POST /orders/{id}/accept': { expectedVersion: 1 },
  'POST /orders/{id}/cancel': { expectedVersion: 1, reason: 'Sintético' },
  'POST /lots/{id}/publish': { version: 1 },
  'POST /lots/{id}/cancel': { version: 1 },
};
/** A body (from the OpenAPI synthetic example when there is one) and the required query. */
const inputFor = (operation: Operation | undefined, key: string) => {
  const content = operation?.requestBody?.content?.['application/json'];
  const body = BODIES[key] ?? Object.values(content?.examples ?? {})[0]?.value ?? {};
  const query = Object.fromEntries(
    (operation?.parameters ?? [])
      .filter((parameter) => parameter.in === 'query' && parameter.required)
      .map((parameter) => [
        parameter.name,
        parameter.schema?.format === 'uuid' ? createId() : parameter.name === 'unit' ? 'kg' : '1',
      ]),
  );
  return { body, query };
};

describePostgres('authorization inventory: every route × every role (Nest + PostgreSQL)', () => {
  let app: INestApplication;
  let pool: pg.Pool;
  let otp: InMemoryOtpSender;
  let routes: Route[];
  let operations: Record<string, Operation>;
  const previousMetricsToken = process.env.METRICS_TOKEN;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    process.env.METRICS_TOKEN = METRICS_TOKEN;
    otp = new InMemoryOtpSender();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(OTP_SENDER)
      .useValue(otp)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    pool = app.get(DATABASE_POOL) as pg.Pool;
    routes = controllerRoutes(app);
    const openapi = JSON.parse(readFileSync(OPENAPI_PATH, 'utf8')) as {
      paths: Record<string, Record<string, Operation>>;
    };
    operations = Object.fromEntries(
      Object.entries(openapi.paths).flatMap(([path, entries]) =>
        Object.entries(entries).map(([method, operation]) => [
          `${method.toUpperCase()} ${path}`,
          operation,
        ]),
      ),
    );
  });

  afterAll(async () => {
    await app?.close();
    if (previousMetricsToken === undefined) delete process.env.METRICS_TOKEN;
    else process.env.METRICS_TOKEN = previousMetricsToken;
  });

  beforeEach(async () => resetPostgresFixtures(pool));

  const account = async (role: Role, index: number): Promise<string> => {
    if (role === 'operator' || role === 'finance' || role === 'admin')
      return (
        await createStaffAccount(app, pool, role, `+57306999${String(index).padStart(4, '0')}`)
      ).token;
    const phone = `306${String(index).padStart(7, '0')}`;
    const deviceId = createId();
    await http()
      .post('/auth/register')
      .send({
        phone,
        role,
        fullName: `Persona ${role}`,
        deviceId,
        platform: 'web',
        consent: { accepted: true, version: 'v0-draft' },
      })
      .expect(201);
    const verified = await http()
      .post('/auth/otp/verify')
      .send({ phone, deviceId, platform: 'web', code: otp.sent.at(-1)?.code })
      .expect(201);
    return verified.body.accessToken as string;
  };

  const call = (route: Route, token?: string) => {
    const path = concrete(route.path);
    const method = route.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
    const { body, query } = inputFor(operations[route.key], route.key);
    let pending = http()[method](path).query(query);
    if (token) pending = pending.set('Authorization', `Bearer ${token}`);
    if (method !== 'get' && method !== 'delete') pending = pending.send(body as object);
    return pending;
  };

  it('documents every route but the listed ones, and guards every route that is not public', () => {
    const openapi = JSON.parse(readFileSync(OPENAPI_PATH, 'utf8')) as {
      paths: Record<string, Record<string, unknown>>;
    };
    const documented = Object.entries(openapi.paths)
      .flatMap(([path, operations]) =>
        Object.keys(operations).map((method) => `${method.toUpperCase()} ${path}`),
      )
      .sort();
    const registered = routes.map(({ key }) => key);
    expect(registered.filter((key) => !documented.includes(key))).toEqual([...UNDOCUMENTED.keys()]);
    expect(documented.filter((key) => !registered.includes(key))).toEqual([]);
    expect(
      routes.filter((route) => !route.guarded && !PUBLIC.has(route.key)).map(({ key }) => key),
    ).toEqual([]);
    expect(
      routes.filter((route) => route.public && !PUBLIC.has(route.key)).map(({ key }) => key),
    ).toEqual([]);
  });

  it('answers 401 to anonymous calls outside the whitelist, and never 401 or 5xx to a session', async () => {
    const tokens = new Map<Role, string>();
    for (const [index, role] of ROLES.entries()) tokens.set(role, await account(role, index + 1));
    // Logging out ends the session, so it runs last.
    const ordered = [...routes].sort(
      (left, right) =>
        Number(left.key === 'POST /auth/logout') - Number(right.key === 'POST /auth/logout'),
    );
    const matrix = new Map<string, Record<string, number>>();
    for (const route of ordered) {
      const row: Record<string, number> = { anonymous: (await call(route)).status };
      for (const role of ROLES) row[role] = (await call(route, tokens.get(role))).status;
      matrix.set(route.key, row);
    }

    const anonymousOutsideWhitelist = [...matrix]
      .filter(([key, row]) => (PUBLIC.get(key) ?? 401) !== row.anonymous)
      .map(([key, row]) => `${key} → ${row.anonymous}`);
    expect(anonymousOutsideWhitelist).toEqual([]);

    // Public routes ignore the session; the webhook only accepts Telegram's secret header.
    const sessionAnomalies = [...matrix]
      .filter(([key]) => !PUBLIC.has(key))
      .flatMap(([key, row]) =>
        ROLES.filter((role) => row[role] === 401 || row[role]! >= 500).map(
          (role) => `${key} as ${role} → ${row[role]}`,
        ),
      );
    expect(sessionAnomalies).toEqual([]);

    // The role guard answers 403 exactly to the roles a route does not list.
    const roleMismatches = routes
      .filter((route) => route.roles && !route.public)
      .flatMap((route) =>
        ROLES.filter(
          (role) => (matrix.get(route.key)![role] === 403) !== !route.roles!.includes(role),
        ).map((role) => `${route.key} as ${role} → ${matrix.get(route.key)![role]}`),
      );
    expect(roleMismatches).toEqual([]);

    const document = formatMarkdown(renderMatrix(routes, matrix), MATRIX_PATH);
    if (process.env.UPDATE_AUTHZ_MATRIX === '1') writeFileSync(MATRIX_PATH, document);
    expect(readFileSync(MATRIX_PATH, 'utf8')).toBe(document);
  }, 120_000);

  it('serves /metrics only with its token', async () => {
    await http().get('/metrics').expect(404);
    await http().get('/metrics').set('Authorization', 'Bearer wrong-token').expect(404);
    await http().get('/metrics').set('Authorization', `Bearer ${METRICS_TOKEN}`).expect(200);
  });
});

const renderMatrix = (routes: readonly Route[], matrix: Map<string, Record<string, number>>) => {
  const columns = ['anonymous', ...ROLES];
  const lines = [
    '# Matriz de autorización (ruta × rol)',
    '',
    'Generada por `apps/api/test/authz-inventory.e2e-spec.ts` (regenerar con `UPDATE_AUTHZ_MATRIX=1`); la prueba falla si este archivo no coincide con lo que responde la API.',
    '',
    'Cada celda es el estado HTTP de una llamada con identificadores aleatorios (UUID v7), un cuerpo válido (el ejemplo sintético de OpenAPI o uno escrito en la prueba) y las consultas obligatorias. Muestra quién pasa la autenticación y la autorización, no el resultado de negocio: `401` sin sesión; `403` el rol no está permitido; `404` recurso inexistente (o ajeno, ver abajo); `2xx` o `409` el rol pasó.',
    '',
    'Columna «Roles»: la lista de `@Roles` (la comprueba el guard antes de leer el cuerpo); «en la aplicación» cuando la comprueba el caso de uso; «pública» para las rutas sin sesión de la lista blanca. La autorización por objeto (usuario A frente a usuario B del mismo rol) está en `apps/api/test/authz-objects.e2e-spec.ts`.',
    '',
    `Rutas: ${routes.length}. Fuera de OpenAPI a propósito: ${[...UNDOCUMENTED]
      .map(([key, why]) => `\`${key}\` (${why})`)
      .join('; ')}.`,
    '',
    `| Ruta | Roles | ${columns.join(' | ')} |`,
    `| ---- | ----- | ${columns.map(() => '---').join(' | ')} |`,
    ...routes.map((route) => {
      const row = matrix.get(route.key)!;
      const roles = PUBLIC.has(route.key)
        ? 'pública'
        : (route.roles?.join(', ') ?? 'en la aplicación');
      return `| \`${route.key}\` | ${roles} | ${columns.map((column) => row[column]).join(' | ')} |`;
    }),
    '',
  ];
  return lines.join('\n');
};
