/**
 * Showcase seed: fills a demo server with 31 synthetic accounts and their activity, then
 * SUSPENDS every one of them, so nobody can sign in with those numbers (a suspended account gets
 * no code and cannot link a chat). Jurors sign up with their own phone and see a full catalog.
 *
 * Accounts: +57 300 000 00NN, NN = 0..30. 0 admin, 1-5 producers, 6-10 suppliers, 11-15 buyers,
 * 16-20 carriers, 21-25 operators, 26-30 finance. Names start with "[DEMO]".
 *
 * It drives the real API (the same flows as `demo:smoke`) with sessions it issues itself, so every
 * rule, event, audit row and ledger entry is the application's own. Demo profile only; undo it with
 * `showcase-purge`. Run inside the API container:
 *   node dist/scripts/showcase-seed.js            (compiled image; --skip-if-seeded on deploys)
 *   pnpm --filter @tracop/api showcase:seed      (source tree, against a running API)
 */
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { Pool } from 'pg';
import sharp from 'sharp';
import { AppModule } from '../src/bootstrap/app.module.js';
import { PhoneNumber } from '../src/modules/identity/domain/phone-number.js';
import type { UserRole } from '../src/modules/identity/domain/user.js';
import { PASSWORDLESS_HASHER, TOKEN_SERVICE } from '../src/modules/identity/ports/tokens.js';
import { DATABASE_POOL } from '../src/shared/infra/tokens.js';
import { createId } from '../src/shared/kernel/ids.js';
import { SHOWCASE_SIZE, showcasePhone, showcaseRole } from './showcase-plan.js';

const profile = process.env.APP_PROFILE ?? 'development';
if (process.env.NODE_ENV === 'production' || !['development', 'demo'].includes(profile))
  throw new Error('showcase-seed only runs in the development or demo profile.');

const API = (
  process.env.SHOWCASE_API_URL ?? `http://127.0.0.1:${process.env.PORT ?? '3000'}`
).replace(/\/$/, '');
const PHOTOS = resolve(process.env.SHOWCASE_PHOTOS_DIR ?? 'scripts/showcase/photos');
const NAMES: Record<UserRole, string[]> = {
  admin: ['Administración'],
  producer: [
    'Finca El Roble',
    'Finca La Esperanza',
    'Finca Los Alisos',
    'Finca El Mirador',
    'Finca San Isidro',
  ],
  supplier: [
    'Acopio Ventaquemada',
    'Cooperativa del Altiplano',
    'Agro Boyacá',
    'Distribuidora Sabana',
    'Centro de Acopio Tunja',
  ],
  buyer: [
    'Restaurante La Huerta',
    'Tienda Don Pedro',
    'Restaurante Sabor Andino',
    'Minimercado El Prado',
    'Restaurante Leña y Fogón',
  ],
  carrier: [
    'Transportes Ruta Andina',
    'Carga Segura',
    'Fletes del Altiplano',
    'Camiones Boyacá',
    'Logística Sabana',
  ],
  operator: ['Operaciones 1', 'Operaciones 2', 'Operaciones 3', 'Operaciones 4', 'Operaciones 5'],
  finance: ['Finanzas 1', 'Finanzas 2', 'Finanzas 3', 'Finanzas 4', 'Finanzas 5'],
};

/** Pickup points (municipality centres, DANE DIVIPOLA) of the pilot corridor. */
const PLACES = [
  { municipality: 'Ventaquemada', department: 'Boyacá', lat: 5.3687, lng: -73.5224 },
  { municipality: 'Tunja', department: 'Boyacá', lat: 5.5353, lng: -73.3678 },
  { municipality: 'Samacá', department: 'Boyacá', lat: 5.4925, lng: -73.4853 },
  { municipality: 'Villa de Leyva', department: 'Boyacá', lat: 5.6337, lng: -73.5265 },
  { municipality: 'Chiquinquirá', department: 'Boyacá', lat: 5.6181, lng: -73.8189 },
  { municipality: 'Zipaquirá', department: 'Cundinamarca', lat: 5.0251, lng: -74.0036 },
  { municipality: 'Ubaté', department: 'Cundinamarca', lat: 5.3079, lng: -73.8158 },
  { municipality: 'Chocontá', department: 'Cundinamarca', lat: 5.1447, lng: -73.6853 },
  { municipality: 'Fusagasugá', department: 'Cundinamarca', lat: 4.3369, lng: -74.3639 },
  { municipality: 'Facatativá', department: 'Cundinamarca', lat: 4.8132, lng: -74.3545 },
];

/** Products of the corridor with a licensed photo (scripts/showcase/photos/credits.json). */
const PRODUCTS = [
  { photo: 'papa-criolla', name: 'Papa criolla', category: 'Tubérculos', price: 2_400 },
  { photo: 'mora', name: 'Mora de Castilla', category: 'Frutas', price: 5_600 },
  { photo: 'cebolla', name: 'Cebolla cabezona', category: 'Hortalizas', price: 2_900 },
  { photo: 'uchuva', name: 'Uchuva', category: 'Frutas', price: 6_200 },
  { photo: 'zanahoria', name: 'Zanahoria', category: 'Hortalizas', price: 1_800 },
  { photo: 'fresa', name: 'Fresa', category: 'Frutas', price: 7_500 },
  { photo: 'lulo', name: 'Lulo', category: 'Frutas', price: 4_800 },
  { photo: 'tomate', name: 'Tomate chonto', category: 'Hortalizas', price: 3_300 },
];

type Json = Record<string, unknown>;
type Account = { index: number; id: string; role: UserRole; name: string; token: string };

const call = async (method: string, path: string, account: Account | null, body?: unknown) => {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(account ? { authorization: `Bearer ${account.token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const json = text ? (JSON.parse(text) as unknown) : {};
  if (response.status >= 300) {
    const code = (json as Json).code ?? (json as Json).message ?? '';
    throw new Error(
      `${method} ${path} as ${account?.role ?? 'anonymous'}: ${response.status} ${String(code)}`,
    );
  }
  return json as Json & Json[];
};

/** Presigned POST. Inside the demo network the public S3 host may not resolve; use the internal one. */
const upload = async (policy: { url: string; fields: Record<string, string> }, body: Buffer) => {
  const publicEndpoint = process.env.S3_PUBLIC_ENDPOINT;
  const internal = process.env.S3_ENDPOINT;
  const url =
    publicEndpoint && internal && policy.url.startsWith(publicEndpoint)
      ? internal + policy.url.slice(publicEndpoint.length)
      : policy.url;
  const form = new FormData();
  for (const [key, value] of Object.entries(policy.fields)) form.append(key, value);
  form.append('file', new Blob([new Uint8Array(body)], { type: 'image/jpeg' }), 'photo.jpg');
  const response = await fetch(url, { method: 'POST', body: form });
  if (response.status >= 300) throw new Error(`upload to S3 answered ${response.status}`);
};

const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

const main = async () => {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const pool = app.get(DATABASE_POOL) as Pool;
  const hasher = app.get(PASSWORDLESS_HASHER) as { hashRefreshToken(token: string): string };
  const tokens = app.get(TOKEN_SERVICE) as {
    issueAccessToken(
      user: unknown,
      sessionId: string,
      deviceId: string,
      now: Date,
    ): Promise<string>;
  };
  const step = (text: string) => process.stdout.write(`  ✓ ${text}\n`);
  // Every showcase account ends suspended: no code, no chat link, no request (data stays).
  const lock = async (ids: string[]) => {
    if (ids.length === 0) return;
    await pool.query(
      `UPDATE identity.users SET status = 'suspended', updated_at = now() WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    await pool.query(
      `UPDATE identity.sessions SET revoked_at = now(), revoked_reason = 'showcase'
       WHERE user_id = ANY($1::uuid[]) AND revoked_at IS NULL`,
      [ids],
    );
    await pool.query(`DELETE FROM identity.channel_links WHERE user_id = ANY($1::uuid[])`, [ids]);
    for (const id of ids)
      await pool.query(
        `INSERT INTO backoffice.audit_log (id, actor_id, actor_role, action, entity, entity_id, before, after, at)
         VALUES ($1, NULL, 'system', 'showcase.suspend', 'user', $2, NULL, '{"status":"suspended"}'::jsonb, now())`,
        [createId(), id],
      );
  };
  const accounts: Account[] = [];
  try {
    const seeded = await pool.query(
      `SELECT count(*)::int AS n FROM identity.users WHERE phone = $1 AND full_name LIKE '[DEMO]%'`,
      [showcasePhone(0)],
    );
    if (seeded.rows[0].n > 0) {
      // Deploys pass --skip-if-seeded: an existing showcase is left as it is.
      if (process.argv.includes('--skip-if-seeded')) {
        process.stdout.write('showcase-seed: already seeded, nothing to do\n');
        return;
      }
      throw new Error('The showcase is already seeded. Run showcase-purge first to seed it again.');
    }

    // 1. Accounts: created (or taken over, if the number exists) active, with a live session.
    const now = new Date();
    for (let index = 0; index < SHOWCASE_SIZE; index++) {
      const role = showcaseRole(index);
      const sameRole = Array.from({ length: index + 1 }, (_, i) => showcaseRole(i)).filter(
        (item) => item === role,
      ).length;
      const name = `[DEMO] ${NAMES[role][sameRole - 1]}`;
      const phone = PhoneNumber.parse(showcasePhone(index));
      if (!phone.ok) throw phone.error;
      const existing = await pool.query<{ id: string }>(
        `SELECT id FROM identity.users WHERE phone = $1`,
        [phone.value.value],
      );
      const id = existing.rows[0]?.id ?? createId();
      if (existing.rows[0]) {
        await pool.query(
          `UPDATE identity.users SET role = $2, full_name = $3, status = 'active',
             phone_verified_at = coalesce(phone_verified_at, $4), updated_at = $4 WHERE id = $1`,
          [id, role, name, now],
        );
      } else {
        await pool.query(
          `INSERT INTO identity.users (id, role, full_name, phone, status, locale, phone_verified_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'active', 'es-CO', $5, $5, $5)`,
          [id, role, name, phone.value.value, now],
        );
      }
      await pool.query(
        `INSERT INTO identity.consents (id, user_id, policy_type, version, accepted_at, channel)
         VALUES ($1, $2, 'privacy', $3, $4, 'app') ON CONFLICT DO NOTHING`,
        [createId(), id, process.env.PRIVACY_POLICY_VERSION ?? 'v0-draft', now],
      );
      const deviceId = createId();
      const sessionId = createId();
      await pool.query(
        `INSERT INTO identity.devices (id, user_id, platform, created_at) VALUES ($1, $2, 'web', $3)`,
        [deviceId, id, now],
      );
      await pool.query(
        `INSERT INTO identity.sessions (id, user_id, device_id, family_id, refresh_hash, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          sessionId,
          id,
          deviceId,
          createId(),
          hasher.hashRefreshToken(randomBytes(32).toString('base64url')),
          new Date(now.getTime() + 3_600_000),
          now,
        ],
      );
      const token = await tokens.issueAccessToken(
        { id, role, phone: phone.value, fullName: name, locale: 'es-CO', status: 'active' },
        sessionId,
        deviceId,
        now,
      );
      accounts.push({ index, id, role, name, token });
    }
    const of = (role: UserRole) => accounts.filter((account) => account.role === role);
    const [operator] = of('operator');
    const [finance] = of('finance');
    const sellers = [...of('producer'), ...of('supplier')];
    step(
      '31 accounts (0 admin, 1-5 producers, 6-10 suppliers, 11-15 buyers, 16-20 carriers, 21-25 operators, 26-30 finance)',
    );

    // 2. Catalog: reuse what exists (same name and kg), create the rest as the operator.
    const categories = (await call('GET', '/catalog/categories', operator!)) as unknown as {
      id: string;
      name: string;
    }[];
    const categoryId = async (name: string) => {
      const found = categories.find((item) => item.name.toLowerCase() === name.toLowerCase());
      if (found) return found.id;
      const created = { id: createId(), name, parentId: null };
      await call('POST', '/catalog/categories', operator!, created);
      categories.push(created);
      return created.id;
    };
    const products = (await call('GET', '/catalog/products', operator!)) as unknown as {
      id: string;
      name: string;
      unit: string;
      status?: string;
    }[];
    const productIds = new Map<string, string>();
    for (const product of PRODUCTS) {
      const found = products.find(
        (item) =>
          item.name.toLowerCase() === product.name.toLowerCase() &&
          item.unit === 'kg' &&
          (item.status ?? 'approved') === 'approved',
      );
      if (found) {
        productIds.set(product.photo, found.id);
        continue;
      }
      const id = createId();
      await call('POST', '/catalog/products', operator!, {
        id,
        categoryId: await categoryId(product.category),
        name: product.name,
        unit: 'kg',
        attributes: {},
      });
      productIds.set(product.photo, id);
    }
    step(`catalog: ${PRODUCTS.length} products of the corridor`);

    // 3. Sellers: provider profile, two lots each with a licensed photo, published.
    const photos = new Map<string, Buffer>();
    for (const product of PRODUCTS)
      photos.set(product.photo, await readFile(resolve(PHOTOS, `${product.photo}.jpg`)));
    const lots: { id: string; seller: Account; product: (typeof PRODUCTS)[number] }[] = [];
    for (const [i, seller] of sellers.entries()) {
      const place = PLACES[i % PLACES.length]!;
      await call('PUT', '/me/provider-profile', seller, {
        displayName: seller.name,
        municipality: place.municipality,
        department: place.department,
        lat: place.lat,
        lng: place.lng,
        description: 'Cuenta de demostración de TRACOP (datos sintéticos).',
      });
      for (const offset of [0, 1]) {
        const product = PRODUCTS[(i * 2 + offset) % PRODUCTS.length]!;
        const lotId = createId();
        await call('POST', '/lots', seller, {
          id: lotId,
          productId: productIds.get(product.photo),
          quantityMilli: String((80 + ((i * 37 + offset * 53) % 320)) * 1000),
          unit: 'kg',
          unitPrice: product.price + ((i + offset) % 4) * 100,
          qualityGrade: offset === 0 ? 'Primera' : 'Segunda',
          availableFrom: days(-0.05),
          availableUntil: days(7 + (i % 5)),
          locationLat: place.lat,
          locationLng: place.lng,
        });
        const photoId = createId();
        const photo = await call('POST', `/lots/${lotId}/photos`, seller, { photoId });
        await upload(photo.uploadPolicy as never, photos.get(product.photo)!);
        await call('POST', `/lots/${lotId}/photos/${photoId}/confirm`, seller);
        await call('POST', `/lots/${lotId}/publish`, seller, { version: 1 });
        lots.push({ id: lotId, seller, product });
      }
    }
    step(`${sellers.length} provider profiles and ${lots.length} published lots with photos`);

    // 4. Trust: three verified providers and one request waiting for review.
    for (const seller of sellers.slice(0, 4))
      await call('POST', '/trust/verification-requests', seller, {
        note: 'Verificación de demostración',
      });
    for (const seller of sellers.slice(0, 3))
      await call('POST', `/trust/staff/verifications/${seller.id}/approve`, operator!, {
        checks: { contact_confirmed: true, location_confirmed: true, reference_checked: true },
      });
    step('3 verified providers, 1 verification pending');

    // 5. Orders: per buyer, one delivered and rated, one paid waiting for a carrier.
    const proof = await sharp({
      create: { width: 320, height: 240, channels: 3, background: '#ffffff' },
    })
      .jpeg()
      .toBuffer();
    const carriers = of('carrier');
    for (const [i, carrier] of carriers.entries())
      await call('POST', '/logistics/carrier-profile', carrier, {
        vehicleType: ['Camión', 'Camioneta', 'Camión', 'Carro', 'Camioneta'][i]!,
        capacityKg: [3000, 1200, 5000, 800, 1500][i]!,
        plate: `DMO${String(100 + i)}`,
      });
    const buyers = of('buyer');
    let delivered = 0;
    let waiting = 0;
    for (const [i, buyer] of buyers.entries()) {
      for (const kind of ['delivered', 'paid'] as const) {
        const lot = lots[(i * 4 + (kind === 'paid' ? 2 : 0)) % lots.length]!;
        const orderId = createId();
        const order = await call('POST', '/orders', buyer, {
          id: orderId,
          lines: [{ lotId: lot.id, quantityMilli: String((5 + i * 3) * 1000) }],
          deliveryAddress: `Calle ${20 + i} # ${10 + i}-${30 + i}, Bogotá (dirección de demostración)`,
        });
        await call('POST', `/orders/${orderId}/accept`, buyer, { expectedVersion: order.version });
        const paymentId = createId();
        await call('POST', `/orders/${orderId}/payment`, buyer, {
          id: paymentId,
          method: 'transfer',
        });
        const proofUpload = await call('POST', `/payments/${paymentId}/proof`, buyer);
        await upload(proofUpload.uploadPolicy as never, proof);
        const confirmed = await call('POST', `/payments/${paymentId}/proof/confirm`, buyer);
        await call('POST', `/payments/${paymentId}/verify`, finance!, {
          expectedVersion: confirmed.version,
        });
        if (kind === 'paid') {
          waiting++;
          continue;
        }
        const carrier = carriers[i % carriers.length]!;
        const trip = await call('POST', '/logistics/trips', carrier, {
          id: createId(),
          orderIds: [orderId],
        });
        const stops = (await call(
          'GET',
          `/logistics/trips/${trip.id}/stops`,
          carrier,
        )) as unknown as {
          id: string;
          kind: string;
        }[];
        for (const kindOfStop of ['pickup', 'delivery'])
          await call(
            'POST',
            `/logistics/stops/${stops.find((s) => s.kind === kindOfStop)!.id}/checkins`,
            carrier,
            {
              id: createId(),
              kind: kindOfStop,
              clientAt: new Date().toISOString(),
            },
          );
        await call('POST', '/trust/ratings', buyer, {
          id: createId(),
          orderId,
          ratee: 'provider',
          score: 4 + (i % 2),
          comment: 'Calificación de demostración',
        });
        await call('POST', '/trust/ratings', buyer, {
          id: createId(),
          orderId,
          ratee: 'carrier',
          score: 5,
        });
        delivered++;
      }
    }
    step(`${delivered} orders delivered and rated, ${waiting} paid and waiting for a carrier`);

    // 6. A product proposal waiting for the operator.
    try {
      await call('POST', '/catalog/product-proposals', of('supplier')[0]!, {
        id: createId(),
        categoryId: await categoryId('Hortalizas'),
        name: 'Ahuyama',
        unit: 'kg',
        attributes: {},
      });
      step('1 product proposal waiting for review');
    } catch (error) {
      // A similar product already exists (409): the catalog is fine without it.
      step(`product proposal skipped (${error instanceof Error ? error.message : 'error'})`);
    }

    await lock(accounts.map((account) => account.id));
    step('31 showcase accounts suspended: nobody can sign in with them');
    process.stdout.write('showcase-seed OK\n');
  } catch (error) {
    // A half-made showcase must not leave usable accounts behind.
    await lock(accounts.map((account) => account.id)).catch(() => undefined);
    throw error;
  } finally {
    await app.close();
  }
};

main().catch((error: unknown) => {
  process.stderr.write(
    `showcase-seed FAILED: ${error instanceof Error ? error.message : 'error'}\n`,
  );
  process.exit(1);
});
