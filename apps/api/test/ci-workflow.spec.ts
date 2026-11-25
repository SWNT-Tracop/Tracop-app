import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const WORKFLOWS = resolve(__dirname, '..', '..', '..', '.github', 'workflows');
const read = (name: string) => readFileSync(join(WORKFLOWS, name), 'utf8');

describe('CI workflow (.github/workflows)', () => {
  it('runs every validation step of ci.yml in order, on Node 22, with read-only permissions', () => {
    const ci = read('ci.yml');
    expect(ci).toMatch(/^permissions:\n {2}contents: read\n/m);
    expect(ci).toMatch(/node-version: 22\n/);
    const steps = [...ci.matchAll(/^ {6}- (?:name: (.+)|run: (.+))$/gm)].map(
      ([, name, run]) => name ?? run,
    );
    expect(steps).toEqual([
      'Read pnpm version from packageManager',
      'pnpm install --frozen-lockfile --ignore-scripts',
      'pnpm db:check-migrations',
      'pnpm openapi:check',
      'pnpm docs:check-matrix',
      'pnpm lint',
      'pnpm typecheck',
      'pnpm build',
      'Start built API and check health',
      'Start built worker, check its jobs and graceful stop',
      'pnpm test',
      'pnpm audit --audit-level=high',
    ]);
    // Testcontainers suites cannot be skipped silently in CI.
    expect(ci).toMatch(/REQUIRE_DOCKER: 1\n/);
  });

  it('pins every action of every workflow to a full commit SHA', () => {
    const uses = readdirSync(WORKFLOWS)
      .filter((name) => name.endsWith('.yml'))
      .flatMap((name) => [...read(name).matchAll(/uses: (\S+)/g)].map(([, action]) => action!));
    expect(uses.length).toBeGreaterThan(0);
    expect(uses.filter((action) => !/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(action))).toEqual([]);
  });
});
