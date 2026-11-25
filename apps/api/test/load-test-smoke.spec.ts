import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const describeDocker =
  process.env.TRACOP_TESTCONTAINER_AVAILABLE === 'true' ? describe : describe.skip;

type Report = {
  measurements: { path: string; requests: number; errors: number; p95: number }[];
  plans: { lots: number; plan: string }[];
  tables: { table: string; rows: string }[];
};

/** The instrument only: a tiny run of scripts/load-test.ts. The numbers are measured by hand. */
describeDocker('load test script (--smoke)', () => {
  it('measures search, pull and push over HTTP and saves the EXPLAIN of the search query', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tracop-load-'));
    try {
      const output = join(directory, 'report.json');
      const result = spawnSync(
        resolve('node_modules/.bin/tsx'),
        ['--tsconfig', 'test/tsconfig.worker.json', 'scripts/load-test.ts', '--smoke'],
        { encoding: 'utf8', env: { ...process.env, LOAD_OUTPUT: output }, timeout: 170_000 },
      );
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      const report = JSON.parse(readFileSync(output, 'utf8')) as Report;
      expect(report.measurements.map(({ path }) => path)).toEqual(['search', 'pull', 'push']);
      expect(
        report.measurements.every(({ requests, errors }) => requests === 4 && errors === 0),
      ).toBe(true);
      expect(report.plans).toHaveLength(1);
      expect(report.plans[0]!.plan).toMatch(/Execution Time: [\d.]+ ms/);
      // 50 seeded lots plus 2 users × 2 pushes × 10 created lots.
      expect(report.tables.find(({ table }) => table === 'catalog.lots')?.rows).toBe('90');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 180_000);
});
