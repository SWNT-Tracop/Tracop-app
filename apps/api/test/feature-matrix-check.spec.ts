import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const REPOSITORY = resolve(__dirname, '..', '..', '..');
const SCRIPT = join(REPOSITORY, 'scripts', 'check-feature-matrix.mjs');

const HEADER = [
  '| ID | Funcionalidad | Estado | Endpoint | Archivo principal | Prueba | NO verificado |',
  '| -- | -- | -- | -- | -- | -- | -- |',
];

/** Runs the real checker against a throwaway repository with the given files and rows. */
const check = (files: Record<string, string>, rows: string[]) => {
  const root = mkdtempSync(join(tmpdir(), 'tracop-matrix-'));
  try {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    writeFileSync(join(root, 'matrix.md'), [...HEADER, ...rows].join('\n'));
    const result = spawnSync(
      process.execPath,
      [SCRIPT, '--root', root, '--matrix', join(root, 'matrix.md')],
      {
        encoding: 'utf8',
      },
    );
    return {
      status: result.status,
      errors: result.stderr
        .split('\n')
        .filter((line) => line.startsWith('- '))
        .map((line) => line.slice(2)),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const FILES = {
  'apps/api/src/a/service.ts': 'export {};',
  'apps/api/src/b/service.ts': 'export {};',
  'apps/api/test/flow.e2e-spec.ts': `
    describe('flow', () => {
      it('publishes a lot', () => {});
      it.each([1, 2])('handles case %s', () => {});
      it.skip('is parked', () => {});
      xit('is parked too', () => {});
    });
    describe.skip('parked suite', () => {
      it('never runs', () => {});
    });
    const describeDocker = process.env.X ? describe : describe.skip;
    describeDocker('database', () => {
      it(\`runs \${'twice'} in a row\`, () => {});
    });`,
};
const row = (id: string, state: string, file: string, test: string) =>
  `| ${id} | F | ${state} | — | ${file} | ${test} | — |`;

describe('feature matrix check (scripts/check-feature-matrix.mjs)', () => {
  jest.setTimeout(30_000);

  it('accepts full paths, existing names, each/template titles, prefixes and counts', () => {
    const result = check(FILES, [
      row(
        'XX-01',
        'implementada',
        '`apps/api/src/a/service.ts`',
        '`apps/api/test/flow.e2e-spec.ts` (3 pruebas) «publishes a lot», «handles case %s», «runs twice in a row», «publi…»',
      ),
    ]);
    expect(result).toEqual({ status: 0, errors: [] });
  });

  it('rejects missing paths and bare or partial names, even when only one file matches', () => {
    const result = check(FILES, [
      row('XX-01', 'parcial', '`service.ts`', '—'),
      row('XX-02', 'parcial', '`a/service.ts`', '—'),
      row('XX-03', 'parcial', '`apps/api/src/c/missing.ts`', '—'),
    ]);
    expect(result.status).toBe(1);
    expect(result.errors).toEqual([
      'XX-01: path not found (write it in full from the repository root): service.ts',
      'XX-02: path not found (write it in full from the repository root): a/service.ts',
      'XX-03: path not found (write it in full from the repository root): apps/api/src/c/missing.ts',
    ]);
  });

  it('rejects names that do not exist or are skipped with it.skip, xit or describe.skip', () => {
    const result = check(FILES, [
      row(
        'XX-01',
        'implementada',
        '—',
        '`apps/api/test/flow.e2e-spec.ts` «is parked», «is parked too», «never runs», «does not exist»',
      ),
    ]);
    expect(result.errors).toEqual([
      'XX-01: «is parked» is skipped in apps/api/test/flow.e2e-spec.ts',
      'XX-01: «is parked too» is skipped in apps/api/test/flow.e2e-spec.ts',
      'XX-01: «never runs» is skipped in apps/api/test/flow.e2e-spec.ts',
      'XX-01: «does not exist» not found in apps/api/test/flow.e2e-spec.ts',
    ]);
  });

  it('rejects a wrong test count, an implemented row without a test and unknown states', () => {
    const result = check(FILES, [
      row('XX-01', 'implementada', '—', '`apps/api/test/flow.e2e-spec.ts` (9 pruebas)'),
      row('XX-02', 'implementada', '`apps/api/src/a/service.ts`', 'medición manual'),
      row('XX-03', 'hecha', '—', '—'),
      row('XX-04', 'parcial', '—', '«orphan name»'),
    ]);
    expect(result.errors).toEqual([
      'XX-01: apps/api/test/flow.e2e-spec.ts says 9 pruebas but declares 3',
      'XX-02: marked «implementada» without citing a test file',
      'XX-03: unknown state «hecha»',
      'XX-04: «orphan name» is not preceded by a test file',
    ]);
  });

  it('passes on the repository matrix', () => {
    const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
