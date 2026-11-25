/**
 * Live walkthrough of the demo stack (`pnpm demo:up` first): API, worker, PostgreSQL and MinIO in
 * docker-compose.demo.yml, synthetic data only. Everything goes over HTTP, as a client would:
 *
 *   registration and OTP → provider profile → product proposal and approval → lot with a photo →
 *   search and order → acceptance → proof → verification → trip, pickup and delivery →
 *   settlement → rating, checking notices and the audit log at every step, and that addresses,
 *   coordinates and the proof never reach a role that must not see them.
 *
 * OTP codes are read from the demo capture file inside the API container (OTP_SENDER=
 * demo_capture), never from the logs. The only shortcut is the claim window (at least 1 h): the
 * script moves the payment's held_at back in the demo database, as the e2e tests do.
 *
 *   pnpm demo:smoke     # DEMO_BIND, DEMO_API_PORT and DEMO_S3_PORT as in demo:up
 */
import { spawnSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { resolve } from 'node:path';
import { createId } from '../src/shared/kernel/ids.js';
import { findCoordinateExposure } from '../test/helpers/coordinate-exposure.js';
import { createSyntheticJpeg } from '../test/helpers/synthetic-image.js';
import { findTextExposure } from '../test/helpers/text-exposure.js';

// Run from apps/api (pnpm demo:smoke does), so the repository root is two levels up.
const ROOT = resolve(process.cwd(), '..', '..');
const BIND = process.env.DEMO_BIND ?? '127.0.0.1';
const API = `http://${BIND}:${process.env.DEMO_API_PORT ?? '3100'}`;
const COMPOSE = ['compose', '-f', 'docker-compose.demo.yml', '--env-file', '.env.demo'];
const WAIT_MS = Number(process.env.DEMO_SMOKE_WAIT_MS ?? 180_000);

type Account = { readonly token: string; readonly userId: string; readonly role: string };
type Json = Record<string, unknown>;

let step = 0;
const ok = (message: string) =>
  process.stdout.write(`  ✓ ${String(++step).padStart(2)} ${message}\n`);
const fail = (message: string): never => {
  throw new Error(message);
};
const expectEqual = (actual: unknown, expected: unknown, what: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    fail(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

const docker = (args: string[], input?: string) => {
  const result = spawnSync('docker', [...COMPOSE, ...args], { cwd: ROOT, encoding: 'utf8', input });
  if (result.status !== 0) fail(`docker ${args.slice(0, 3).join(' ')} failed`);
  return result.stdout;
};
/** Runs SQL in the demo database (synthetic data); returns rows as arrays of strings. */
const sql = (query: string): string[][] =>
  docker(
    ['exec', '-T', 'db', 'sh', '-c', 'psql -X -q -At -F "|" -U "$POSTGRES_USER" -d "$POSTGRES_DB"'],
    query,
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('|'));

const call = async (
  method: string,
  path: string,
  account?: Account,
  body?: unknown,
): Promise<{ status: number; body: Json }> => {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(account ? { authorization: `Bearer ${account.token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Json) : {} };
};
const must = async (
  status: number,
  method: string,
  path: string,
  account?: Account,
  body?: unknown,
): Promise<Json> => {
  const response = await call(method, path, account, body);
  if (response.status !== status)
    fail(
      `${method} ${path} as ${account?.role ?? 'anonymous'}: expected ${status}, got ${response.status} ${JSON.stringify(response.body).slice(0, 200)}`,
    );
  return response.body;
};

const until = async <T>(what: string, probe: () => Promise<T | undefined>): Promise<T> => {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) fail(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 2_000));
  }
};

/** The code the demo capture sender wrote for this phone, newest first. */
const otpFor = (phone: string): string | undefined =>
  docker(['exec', '-T', 'api', 'sh', '-c', 'cat /run/tracop-otp/codes.jsonl 2>/dev/null || true'])
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { phone: string; code: string })
    .reverse()
    .find((entry) => entry.phone === phone)?.code;

const login = async (role: string, phone: string, register: boolean): Promise<Account> => {
  const national = phone.slice(3);
  const deviceId = createId();
  if (register)
    await must(201, 'POST', '/auth/register', undefined, {
      phone: national,
      role,
      fullName: `Persona sintética ${role}`,
      deviceId,
      platform: 'web',
      consent: { accepted: true, version: 'v0-draft' },
    });
  else await must(201, 'POST', '/auth/otp/request', undefined, { phone: national });
  const code = await until(`the OTP of the ${role}`, async () => otpFor(phone));
  const verified = await must(201, 'POST', '/auth/otp/verify', undefined, {
    phone: national,
    deviceId,
    platform: 'web',
    code,
  });
  return {
    token: verified.accessToken as string,
    userId: (verified.user as Json).id as string,
    role,
  };
};

const auditSince = (mark: string) =>
  sql(
    `SELECT actor_role || ':' || action FROM backoffice.audit_log WHERE at > '${mark}'::timestamptz ORDER BY at, id`,
  ).map(([entry]) => entry!);
const now = () => sql('SELECT clock_timestamp()')[0]![0]!;
const inboxKinds = async (account: Account) =>
  ((await must(200, 'GET', '/me/inbox?limit=50', account)).items as { kind: string }[])
    .map(({ kind }) => kind)
    .sort();
const waitForNotice = (account: Account, kind: string) =>
  until(`notice ${kind} for the ${account.role}`, async () =>
    (await inboxKinds(account)).includes(kind) ? true : undefined,
  );

/** Uploads to a presigned POST of the demo S3, as the app would. */
const upload = async (policy: { url: string; fields: Record<string, string> }, body: Buffer) => {
  const form = new FormData();
  for (const [key, value] of Object.entries(policy.fields)) form.append(key, value);
  form.append('file', new Blob([new Uint8Array(body)], { type: 'image/jpeg' }), 'photo.jpg');
  const response = await fetch(policy.url, { method: 'POST', body: form });
  if (response.status >= 300) fail(`upload to S3 answered ${response.status}`);
};

/** Fails when any of the secrets appears anywhere in what a role received. */
const privateFrom = (what: string, received: unknown, secrets: Secrets) => {
  const coordinates = findCoordinateExposure(received, [secrets.lot]);
  const texts = findTextExposure(received, [secrets.address, ...secrets.proofKeys]);
  if (coordinates.length || texts.length)
    fail(`${what} exposes ${[...coordinates, ...texts].map(({ path }) => path).join(', ')}`);
};
type Secrets = {
  readonly lot: { latitude: number; longitude: number };
  readonly address: string;
  proofKeys: string[];
};

const main = async () => {
  const health = await fetch(`${API}/health`).catch(() => null);
  if (!health?.ok) fail(`the demo API does not answer on ${API}; run pnpm demo:up first`);
  const run = randomInt(1_000_000, 9_999_999);
  const phone = (prefix: number) => `+57${prefix}${run}`;
  const secrets: Secrets = {
    lot: { latitude: 5.5317, longitude: -73.3616 },
    address: `Calle sintética ${run} # 1-23, Bogotá`,
    proofKeys: [],
  };
  process.stdout.write(`demo:smoke run ${run} against ${API}\n`);

  // 1. Accounts: three self-registered users and the seeded staff, all through OTP.
  const producer = await login('producer', phone(310), true);
  const buyer = await login('buyer', phone(311), true);
  const carrier = await login('carrier', phone(312), true);
  const operator = await login('operator', '+573000000005', false);
  const finance = await login('finance', '+573000000006', false);
  ok(
    'registration and OTP from the demo capture file (producer, buyer, carrier, operator, finance)',
  );

  // 2. Provider profile.
  await must(200, 'PUT', '/me/provider-profile', producer, {
    displayName: `Finca sintética ${run}`,
    municipality: 'Tunja',
    department: 'Boyacá',
    lat: secrets.lot.latitude,
    lng: secrets.lot.longitude,
    description: 'Dato sintético de la demo',
  });
  ok('provider profile');

  // 3. Product proposal, approved by the operator (audited).
  const categories = (await must(200, 'GET', '/catalog/categories', producer)) as unknown as {
    id: string;
  }[];
  const categoryId = categories[0]!.id;
  const proposalId = createId();
  let mark = now();
  await must(201, 'POST', '/catalog/product-proposals', producer, {
    id: proposalId,
    categoryId,
    name: `Uchuva sintética ${run}`,
    unit: 'kg',
    attributes: {},
  });
  await must(201, 'POST', `/catalog/product-proposals/${proposalId}/approve`, operator);
  expectEqual(auditSince(mark), ['operator:product_proposal.approve'], 'audit after approval');
  ok('product proposal approved by the operator, audited');

  // 4. Lot with a photo through the demo S3, then published.
  const lotId = createId();
  await must(201, 'POST', '/lots', producer, {
    id: lotId,
    productId: proposalId,
    quantityMilli: '50000',
    unit: 'kg',
    unitPrice: 6_000,
    qualityGrade: 'Primera',
    availableFrom: new Date(Date.now() - 3_600_000).toISOString(),
    availableUntil: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    locationLat: secrets.lot.latitude,
    locationLng: secrets.lot.longitude,
  });
  const photoId = createId();
  const photo = await must(201, 'POST', `/lots/${lotId}/photos`, producer, { photoId });
  await upload(photo.uploadPolicy as never, await createSyntheticJpeg({ width: 320, height: 240 }));
  await must(201, 'POST', `/lots/${lotId}/photos/${photoId}/confirm`, producer);
  await must(201, 'POST', `/lots/${lotId}/publish`, producer, { version: 1 });
  ok('lot created, photo uploaded to S3 and processed, lot published');

  // 5. The buyer finds it (photo, no exact location, no provider id) and orders.
  const search = await until('the lot in search', async () => {
    const found = await must(200, 'GET', `/lots?q=uchuva`, buyer);
    return (found.items as Json[]).some(({ id }) => id === lotId) ? found : undefined;
  });
  const item = (search.items as Json[]).find(({ id }) => id === lotId)!;
  expectEqual((item.photos as Json[]).length, 1, 'photos in search');
  if ('providerId' in item) fail('search exposes providerId');
  privateFrom('search for the buyer', search, secrets);
  privateFrom('lot detail for the buyer', await must(200, 'GET', `/lots/${lotId}`, buyer), secrets);
  const orderId = createId();
  const order = await must(201, 'POST', '/orders', buyer, {
    id: orderId,
    lines: [{ lotId, quantityMilli: '10000' }],
    deliveryAddress: secrets.address,
  });
  ok('buyer search with photo and without exact location; order quoted');

  // 6. Acceptance: the producer is told, and never sees the address.
  await must(200, 'POST', `/orders/${orderId}/accept`, buyer, { expectedVersion: order.version });
  await waitForNotice(producer, 'order_received');
  privateFrom(
    'order for the provider',
    await must(200, 'GET', `/orders/${orderId}`, producer),
    secrets,
  );
  privateFrom(
    'incoming orders for the provider',
    await must(200, 'GET', '/orders/incoming', producer),
    secrets,
  );
  privateFrom('inbox of the provider', await must(200, 'GET', '/me/inbox', producer), secrets);
  ok('acceptance notified to the producer, without the delivery address');

  // 7. Proof through the demo S3; only the buyer and staff see it.
  const paymentId = createId();
  await must(201, 'POST', `/orders/${orderId}/payment`, buyer, {
    id: paymentId,
    method: 'transfer',
  });
  const proof = await must(201, 'POST', `/payments/${paymentId}/proof`, buyer);
  const policy = proof.uploadPolicy as { url: string; fields: Record<string, string> };
  secrets.proofKeys.push(policy.fields.key!);
  await upload(policy, await createSyntheticJpeg());
  const confirmed = await must(200, 'POST', `/payments/${paymentId}/proof/confirm`, buyer);
  const stored = sql(`SELECT proof_key FROM payments.payments WHERE id = '${paymentId}'`)[0]![0]!;
  secrets.proofKeys.push(stored);
  await must(404, 'GET', `/payments/${paymentId}`, producer);
  await must(404, 'GET', `/payments/${paymentId}`, carrier);
  privateFrom(
    'order for the provider after the proof',
    await must(200, 'GET', `/orders/${orderId}`, producer),
    secrets,
  );
  ok('proof uploaded; the provider and the carrier get 404 for the payment');

  // 8. Finance verifies (audited): both parties told.
  mark = now();
  await must(200, 'POST', `/payments/${paymentId}/verify`, finance, {
    expectedVersion: confirmed.version,
  });
  expectEqual(auditSince(mark), ['finance:payment.verify'], 'audit after verification');
  await waitForNotice(buyer, 'payment_verified_buyer');
  await waitForNotice(producer, 'payment_verified_provider');
  ok('payment verified by finance, audited, notified to buyer and producer');

  // 9. Trip, pickup and delivery: the carrier sees the exact location only through its
  // audited endpoint; trips and stops never carry it.
  await must(201, 'POST', '/logistics/carrier-profile', carrier, {
    vehicleType: 'Camion',
    capacityKg: 2000,
    plate: `DMO${String(run).slice(-3)}`,
  });
  const trip = await must(201, 'POST', '/logistics/trips', carrier, {
    id: createId(),
    orderIds: [orderId],
  });
  const stops = (await must(
    200,
    'GET',
    `/logistics/trips/${trip.id}/stops`,
    carrier,
  )) as unknown as {
    id: string;
    kind: string;
  }[];
  privateFrom('trip for the carrier', trip, secrets);
  privateFrom('stops for the carrier', stops, secrets);
  const pickup = stops.find(({ kind }) => kind === 'pickup')!;
  const delivery = stops.find(({ kind }) => kind === 'delivery')!;
  mark = now();
  await must(200, 'GET', `/logistics/trips/${trip.id}/stops/${pickup.id}/location`, carrier);
  await must(404, 'GET', `/logistics/trips/${trip.id}/stops/${pickup.id}/location`, buyer);
  expectEqual(
    auditSince(mark),
    ['carrier:location.view', 'buyer:location.view'],
    'audit of location reads',
  );
  for (const stop of [pickup, delivery])
    await must(201, 'POST', `/logistics/stops/${stop.id}/checkins`, carrier, {
      id: createId(),
      kind: stop.kind,
      clientAt: new Date().toISOString(),
    });
  await waitForNotice(buyer, 'delivered');
  expectEqual(
    (await must(200, 'GET', `/orders/${orderId}`, buyer)).status,
    'delivered',
    'order status after delivery',
  );
  await until('the payment held after delivery', async () =>
    (await must(200, 'GET', `/payments/${paymentId}`, buyer)).status === 'held' ? true : undefined,
  );
  privateFrom('inbox of the carrier', await must(200, 'GET', '/me/inbox', carrier), secrets);
  ok('trip, pickup and delivery; location read audited, buyer refused; payment held');

  // 10. Settlement: the claim window is simulated; the worker issues it, finance pays it.
  sql(
    `UPDATE payments.payments SET held_at = held_at - interval '721 hours' WHERE id = '${paymentId}'`,
  );
  const settlement = await until('the producer settlement', async () => {
    const items = (await must(200, 'GET', '/settlements', producer)).items as Json[];
    return items.find(({ beneficiaryKind }) => beneficiaryKind === 'producer');
  });
  privateFrom('settlements for the producer', settlement, secrets);
  await waitForNotice(producer, 'settlement_issued');
  mark = now();
  await must(200, 'POST', `/settlements/${settlement.id}/paid`, finance, {
    expectedVersion: settlement.version,
    reference: `DEMO-${run}`,
  });
  expectEqual(auditSince(mark), ['finance:settlement.mark_paid'], 'audit after settlement');
  await waitForNotice(producer, 'settlement_paid');
  ok('settlement issued by the worker, paid by finance, audited and notified');

  // 11. Rating by the buyer; the ledger balances.
  await must(201, 'POST', '/trust/ratings', buyer, {
    id: createId(),
    orderId,
    ratee: 'provider',
    score: 5,
    comment: 'Demo sintética',
  });
  await must(409, 'POST', '/trust/ratings', buyer, {
    id: createId(),
    orderId,
    ratee: 'provider',
    score: 4,
  });
  const unbalanced = sql(
    `SELECT transaction_id FROM payments.ledger_entries WHERE order_id = '${orderId}' GROUP BY transaction_id HAVING sum(debit) <> sum(credit)`,
  );
  expectEqual(unbalanced, [], 'unbalanced ledger transactions');
  ok('rating accepted once; ledger balanced');

  // 12. Notices of the whole walkthrough.
  expectEqual(
    await inboxKinds(producer),
    ['order_received', 'payment_verified_provider', 'settlement_issued', 'settlement_paid'],
    'producer notices',
  );
  expectEqual(
    await inboxKinds(buyer),
    ['delivered', 'in_transit', 'payment_verified_buyer', 'pickup_scheduled'],
    'buyer notices',
  );
  ok('every notice of the walkthrough, once');
  process.stdout.write(`demo:smoke OK (${step} steps)\n`);
};

main().catch((error: unknown) => {
  process.stderr.write(
    `demo:smoke FAILED at step ${step + 1}: ${error instanceof Error ? error.message : 'error'}\n`,
  );
  process.exit(1);
});
