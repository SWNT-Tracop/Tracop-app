import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve('apps/api/src');

async function runEslint(fixturePath) {
  const result = spawnSync(
    'pnpm',
    ['exec', 'eslint', '--config', resolve('packages/config/eslint.config.js'), fixturePath],
    { encoding: 'utf8', cwd: resolve(repoRoot, '../../..') },
  );
  return { status: result.status ?? 1, output: `${result.stdout}${result.stderr}` };
}

async function testFixture(name, elementType, importPath, shouldFail) {
  // Create fixture under a real module path to trigger the file-pattern rules
  const moduleName = elementType === 'bootstrap' ? 'catalog' : 'ordering';
  // Map elementType to actual directory structure
  const dirMap = {
    domain: 'domain',
    application: 'application',
    ports: 'ports',
    'adapters-in': 'adapters/in',
    'adapters-out': 'adapters/out',
    bootstrap: 'bootstrap',
  };
  const dir = dirMap[elementType] ?? elementType;

  // For bootstrap, the config pattern is 'bootstrap/**' at repo root, not under modules/
  const temp =
    elementType === 'bootstrap'
      ? resolve(repoRoot, `bootstrap/__boundary-fixture`)
      : resolve(repoRoot, `modules/${moduleName}/${dir}/__boundary-fixture`);

  try {
    await mkdir(temp, { recursive: true });
    const fixture = join(temp, 'invalid.ts');
    await writeFile(fixture, `import '${importPath}';\n`);
    console.log(`[DEBUG] Testing ${name}: fixture at ${fixture}`);
    const { status, output } = await runEslint(fixture);
    console.log(`[DEBUG] ESLint status: ${status}, output: ${output}`);
    const passed = status === 0;
    if (shouldFail && passed) {
      process.stderr.write(`[FAIL] ${name}: fixture unexpectedly passed ESLint.\n${output}`);
      process.exitCode = 1;
    } else if (!shouldFail && !passed) {
      process.stderr.write(`[FAIL] ${name}: fixture unexpectedly failed ESLint.\n${output}`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`[OK] ${name}: ${shouldFail ? 'rejected' : 'accepted'} as expected.\n`);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function main() {
  process.exitCode = 0;

  // Existing: domain cannot import shared/infra
  await testFixture(
    'domain -> shared/infra',
    'domain',
    '../../../shared/infra/system-clock.ts',
    true,
  );

  // NEW: Cross-module imports via non-public APIs must FAIL
  await testFixture(
    'ordering adapters-out -> catalog adapters-out',
    'adapters-out',
    '../../../catalog/adapters/out/drizzle-schema.ts',
    true,
  );
  await testFixture(
    'catalog adapters-out -> identity ports',
    'adapters-out',
    '../../../identity/ports/tokens.ts',
    true,
  );
  await testFixture(
    'bootstrap -> catalog ports',
    'bootstrap',
    '../modules/catalog/ports/catalog-ports.ts',
    true,
  );

  // NEW: bootstrap -> catalog/index.ts must PASS
  await testFixture(
    'bootstrap -> catalog index.ts (public API)',
    'bootstrap',
    '../modules/catalog/index.ts',
    false,
  );

  // NEW: ordering adapters-out -> catalog index.ts must PASS (public API)
  await testFixture(
    'ordering adapters-out -> catalog index.ts (public API)',
    'adapters-out',
    '../../../catalog/index.ts',
    false,
  );
}

main();
