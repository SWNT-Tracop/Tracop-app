import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..', '..');
const SRC = join(__dirname, '..', 'src');
const ESLINT = join(ROOT, 'node_modules', '.bin', 'eslint');

/** Runs the repository's real ESLint config (an ESM file) in a child process on stdin. */
const rulesFor = async (relativePath: string, code: string): Promise<string[]> => {
  let output: string;
  try {
    output = execFileSync(
      ESLINT,
      ['--stdin', '--stdin-filename', join(SRC, relativePath), '--format', 'json'],
      { cwd: ROOT, input: code, encoding: 'utf8' },
    );
  } catch (error) {
    // ESLint exits with 1 when it reports errors; the JSON is still on stdout.
    output = String((error as { stdout?: string }).stdout ?? '[]');
  }
  const [result] = JSON.parse(output) as { messages: { ruleId: string | null }[] }[];
  return (result?.messages ?? []).map(({ ruleId }) => ruleId ?? 'fatal').sort();
};

describe('layer rule (eslint-plugin-boundaries with the TypeScript resolver)', () => {
  jest.setTimeout(60_000);

  it('rejects a domain file that imports infrastructure', async () => {
    expect(
      await rulesFor(
        'modules/trust/domain/probe.ts',
        "import { DatabaseService } from '../../../shared/infra/database.js';\nexport const probe = DatabaseService;\n",
      ),
    ).toContain('boundaries/element-types');
  });

  it('rejects an application service that imports an outbound adapter', async () => {
    expect(
      await rulesFor(
        'modules/trust/application/probe.ts',
        "import { DrizzleTrustRepository } from '../adapters/out/drizzle-trust-repository.js';\nexport const probe = DrizzleTrustRepository;\n",
      ),
    ).toContain('boundaries/element-types');
  });

  it('allows the dependencies the architecture permits, and fakes in tests', async () => {
    expect(
      await rulesFor(
        'modules/trust/application/probe.ts',
        "import { DomainError } from '../../../shared/kernel/domain-error.js';\nimport { averageTenths } from '../domain/rating.js';\nexport const probe = [DomainError, averageTenths];\n",
      ),
    ).toEqual([]);
    expect(
      await rulesFor(
        'modules/ai-assistant/application/probe.spec.ts',
        "import { FakeLLMAdapter } from '../adapters/out/fake-llm.adapter.js';\nexport const probe = FakeLLMAdapter;\n",
      ),
    ).toEqual([]);
  });
});
