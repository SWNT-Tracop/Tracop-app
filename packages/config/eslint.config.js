import eslint from '@eslint/js';
import boundaries from 'eslint-plugin-boundaries';
import globals from 'globals';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../apps/api/src');

export default [
  { ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**'] },
  eslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.js', '**/*.mjs', '**/*.cjs'],
    languageOptions: {
      globals: { ...globals.node, ...globals.jest },
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    },
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
        { type: 'infrastructure', pattern: 'shared/infra/**' },
        { type: 'shared-ports', pattern: 'shared/ports/**' },
      ],
    },
    rules: {
      'no-undef': 'error',
      'boundaries/element-types': [
        'error',
        {
          default: 'allow',
          rules: [
            { from: 'domain', allow: ['domain', 'kernel'] },
            {
              from: 'application',
              allow: ['application', 'domain', 'ports', 'shared-ports', 'kernel'],
            },
            { from: 'ports', allow: ['ports', 'domain', 'shared-ports', 'kernel'] },
            {
              from: 'adapters-in',
              allow: [
                'adapters-in',
                'application',
                'ports',
                'domain',
                'shared-ports',
                'kernel',
                'infrastructure',
                'module-public',
              ],
            },
            {
              from: 'adapters-out',
              allow: [
                'adapters-out',
                'ports',
                'domain',
                'shared-ports',
                'kernel',
                'infrastructure',
                'module-public',
              ],
            },
            { from: 'module-public', allow: ['module-public', 'application', 'domain', 'ports'] },
          ],
        },
      ],
      'boundaries/no-private': ['error', { allowUncles: false }],
    },
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: { 'no-unused-vars': 'off', '@typescript-eslint/no-unused-vars': 'error' },
  },
  {
    files: ['**/modules/*/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/shared/infra/**',
                '**/application/**',
                '**/adapters/**',
                '@nestjs/**',
                'drizzle-orm',
                'pg',
              ],
              message: 'Domain can depend only on domain primitives and the shared kernel.',
            },
          ],
        },
      ],
    },
  },
];
