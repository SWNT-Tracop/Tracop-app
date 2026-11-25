import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '..', 'src');
const MODULE = join(SRC, 'modules', 'ai-assistant');

const files = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return files(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });

const importsOf = (file: string): string[] =>
  [...readFileSync(file, 'utf8').matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]!);

describe('ai-assistant module boundaries', () => {
  it('imports no other business module, not even its public index', () => {
    const offending = files(MODULE).flatMap((file) =>
      importsOf(file)
        .filter((path) =>
          /(^|\/)(catalog|ordering|logistics|identity|payments|notifications|messaging|sync|backoffice|trust)(\/|$)/.test(
            path,
          ),
        )
        .map((path) => `${relative(SRC, file)} -> ${path}`),
    );
    expect(offending).toEqual([]);
  });

  it('is reached by other code only through its index, from bootstrap', () => {
    const users = files(SRC)
      .filter((file) => !file.startsWith(MODULE) && !file.endsWith('.spec.ts'))
      .flatMap((file) =>
        importsOf(file)
          .filter((path) => /modules\/ai-assistant\//.test(path))
          .map((path) => `${relative(SRC, file)} -> ${path.replace(/^(\.\.\/)+/, '')}`),
      )
      .sort();
    expect(users).toEqual([
      'bootstrap/ai-assistant-bridge.module.ts -> modules/ai-assistant/index.js',
      'bootstrap/app.module.ts -> modules/ai-assistant/index.js',
      'bootstrap/recommendations-bridge.module.ts -> modules/ai-assistant/index.js',
      'bootstrap/worker-jobs.ts -> modules/ai-assistant/index.js',
      'bootstrap/worker-lifecycle.ts -> modules/ai-assistant/index.js',
    ]);
  });

  it('gives the model no tools: the only request shape is system, user, schema and a token limit', () => {
    const port = readFileSync(join(MODULE, 'ports', 'assistant-ports.ts'), 'utf8');
    const request = /export interface LLMRequest \{([\s\S]*?)\n\}/.exec(port)![1]!;
    const fields = [...request.matchAll(/readonly (\w+):/g)].map((match) => match[1]);
    expect(fields).toEqual(['system', 'user', 'jsonSchema', 'maxOutputTokens']);
    const adapter = readFileSync(
      join(MODULE, 'adapters', 'out', 'anthropic-llm.adapter.ts'),
      'utf8',
    );
    expect(/\btools\b|tool_choice/.test(adapter)).toBe(false);
  });
});
