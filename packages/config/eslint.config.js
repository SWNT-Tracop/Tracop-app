import eslint from '@eslint/js';
import boundaries from 'eslint-plugin-boundaries';
import globals from 'globals';
import tsParser from '@typescript-eslint/parser';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../apps/api/src');

export default [
  { ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**'] },
  eslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.js', '**/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.jest }, parserOptions: { ecmaVersion: 'latest', sourceType: 'module' } },
    plugins: { boundaries },
    settings: {
      'boundaries/root-path': repoRoot,
      'boundaries/elements': [
        { type: 'domain', pattern: 'modules/*/domain/**' },
        { type: 'application', pattern: 'modules/*/application/**' },
        { type: 'ports', pattern: 'modules/*/ports/**' },
        { type: 'adapters-in', pattern: 'modules/*/adapters/in/**' },
        { type: 'adapters-out', pattern: 'modules/*/adapters/out/**' },
        { type: 'module-public', pattern: 'modules/*/index.ts' },
        { type: 'kernel', pattern: 'shared/kernel/**' },
        { type: 'infrastructure', pattern: 'shared/infrastructure/**' },
      ],
    },
    rules: {
      'no-undef': 'error',
      'no-restricted-imports': ['error', { patterns: [{ group: ['**/shared/infrastructure/**'], message: 'Domain can only depend on shared kernel primitives.' }] }],
      'boundaries/element-types': ['error', {
        default: 'allow',
        rules: [
          { from: 'domain', allow: ['domain', 'kernel'] },
          { from: 'application', allow: ['application', 'domain', 'ports', 'kernel'] },
          { from: 'ports', allow: ['ports', 'domain', 'kernel'] },
          { from: 'adapters-in', allow: ['adapters-in', 'application', 'ports', 'domain', 'kernel', 'infrastructure', 'module-public'] },
          { from: 'adapters-out', allow: ['adapters-out', 'ports', 'domain', 'kernel', 'infrastructure', 'module-public'] },
          { from: 'module-public', allow: ['module-public', 'application', 'domain', 'ports'] },
        ],
      }],
      'boundaries/no-private': ['error', { allowUncles: false }],
    },
  },
  { files: ['**/*.ts'], languageOptions: { parser: tsParser, parserOptions: { ecmaVersion: 'latest', sourceType: 'module' } } },
];
