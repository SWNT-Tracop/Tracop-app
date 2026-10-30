import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const temp = resolve('apps/api/src/modules/__boundary-fixture/domain');
try {
  await mkdir(temp, { recursive: true });
  const fixture = join(temp, 'invalid.ts');
  await writeFile(fixture, "import '../../../shared/infra/system-clock.ts';\n");
  const result = spawnSync(
    'pnpm',
    ['exec', 'eslint', '--config', resolve('packages/config/eslint.config.js'), fixture],
    { encoding: 'utf8' },
  );
  if (result.error) throw result.error;
  if (result.status === 0) {
    process.stderr.write(
      `Boundary fixture unexpectedly passed ESLint.\n${result.stdout}${result.stderr}`,
    );
    process.exitCode = 1;
  } else if (!`${result.stdout}${result.stderr}`.includes('no-restricted-imports')) {
    process.stderr.write(`${result.stdout}${result.stderr}`);
    process.exitCode = 1;
  } else {
    process.stdout.write('Boundary rule rejects the invalid fixture as expected.\n');
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}
