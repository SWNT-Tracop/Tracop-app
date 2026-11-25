import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..', '..');
const read = (path: string) => readFileSync(resolve(ROOT, path), 'utf8');

describe('docs/ENV-CRITICALITY.md', () => {
  it('classifies exactly the variables of the env.ts schema and of .env.example', () => {
    const source = read('apps/api/src/shared/infra/env.ts');
    const schema = source.slice(source.indexOf('z.object({'), source.indexOf('\n})'));
    const expected = new Set([
      ...[...schema.matchAll(/^ {2}([A-Z][A-Z0-9_]+):/gm)].map(([, key]) => key!),
      ...[...read('.env.example').matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map(([, key]) => key!),
    ]);
    const documented = [
      ...read('docs/ENV-CRITICALITY.md').matchAll(/^\| `([A-Z][A-Z0-9_]*)` +\|/gm),
    ].map(([, key]) => key!);
    expect(documented.length).toBe(new Set(documented).size);
    expect([...expected].filter((key) => !documented.includes(key))).toEqual([]);
    expect(documented.filter((key) => !expected.has(key))).toEqual([]);
  });

  it('marks every secret the application reads as critical and to be rotated', () => {
    const rows = new Map(
      [
        ...read('docs/ENV-CRITICALITY.md').matchAll(
          /^\| `([A-Z0-9_]+)` +\| ([^|]+)\| (sí|no) +\|/gm,
        ),
      ].map(([, key, level, rotate]) => [key!, `${level!.trim()}/${rotate}`]),
    );
    for (const key of [
      'JWT_SECRET',
      'OTP_HMAC_SECRET',
      'RATE_LIMIT_HMAC_SECRET',
      'TELEGRAM_BOT_TOKEN',
      'TELEGRAM_WEBHOOK_SECRET',
      'S3_API_SECRET_KEY',
      'S3_POLICY_SECRET_KEY',
      'LLM_API_KEY',
      'METRICS_TOKEN',
      'DATABASE_URL',
    ])
      expect([key, rows.get(key)]).toEqual([key, 'Crítica/sí']);
  });
});
