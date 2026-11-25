import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '..', 'src');
const MODULE = join(SRC, 'modules', 'recommendations');

const files = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return files(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });

const importsOf = (file: string): string[] =>
  [...readFileSync(file, 'utf8').matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]!);

describe('recommendations module boundaries', () => {
  it('imports no other business module, and its SQL touches no other schema', () => {
    const offending = files(MODULE).flatMap((file) => [
      ...importsOf(file)
        .filter((path) =>
          /(^|\/)(catalog|ordering|logistics|identity|payments|notifications|messaging|sync|backoffice|trust|ai-assistant)(\/|$)/.test(
            path,
          ),
        )
        .map((path) => `${relative(SRC, file)} -> ${path}`),
      ...[
        ...readFileSync(file, 'utf8').matchAll(
          /\b(catalog|ordering|identity|payments|trust|logistics|ai_assistant|notifications)\.[a-z_]+/g,
        ),
      ]
        .filter(() => file.includes(join('adapters', 'out')))
        .map((match) => `${relative(SRC, file)} reads ${match[0]}`),
    ]);
    expect(offending).toEqual([]);
  });

  it('is reached only through its index, from bootstrap', () => {
    const users = files(SRC)
      .filter((file) => !file.startsWith(MODULE) && !file.endsWith('.spec.ts'))
      .filter((file) => importsOf(file).some((path) => /modules\/recommendations\//.test(path)))
      .map((file) => relative(SRC, file))
      .sort();
    expect(users).toEqual([
      'bootstrap/app.module.ts',
      'bootstrap/recommendations-bridge.module.ts',
      'bootstrap/worker.module.ts',
    ]);
  });
});
