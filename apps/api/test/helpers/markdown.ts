import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..', '..', '..');
const PRETTIER = join(ROOT, 'node_modules', '.bin', 'prettier');

/**
 * Formats generated Markdown with the repository's Prettier (as lint-staged does on commit), so a
 * committed document stays byte for byte equal. Prettier runs in a child process: Jest cannot
 * load it (it imports its plugins dynamically).
 */
export const formatMarkdown = (text: string, path: string): string =>
  execFileSync(PRETTIER, ['--stdin-filepath', path], { cwd: ROOT, input: text, encoding: 'utf8' });
