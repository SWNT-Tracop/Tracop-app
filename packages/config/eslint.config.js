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
        { type: 'bootstrap', pattern: 'bootstrap/**' },
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
            {
              from: 'bootstrap',
              allow: ['module-public', 'kernel', 'infrastructure', 'shared-ports'],
            },
          ],
        },
      ],
      'boundaries/no-private': ['error', { allowUncles: false }],
    },
  },
  {
    files: [
      '**/modules/*/domain/**/*.ts',
      '**/modules/*/application/**/*.ts',
      '**/modules/*/ports/**/*.ts',
      '**/modules/*/adapters/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/catalog/adapters/**',
                '**/catalog/ports/**',
                '**/catalog/domain/**',
                '**/catalog/application/**',
                '**/identity/adapters/**',
                '**/identity/ports/**',
                '**/identity/domain/**',
                '**/identity/application/**',
                '**/ordering/adapters/**',
                '**/ordering/ports/**',
                '**/ordering/domain/**',
                '**/ordering/application/**',
                '**/sync/adapters/**',
                '**/sync/ports/**',
                '**/sync/domain/**',
                '**/sync/application/**',
                '**/messaging/adapters/**',
                '**/messaging/ports/**',
                '**/messaging/domain/**',
                '**/messaging/application/**',
                '**/notifications/adapters/**',
                '**/notifications/ports/**',
                '**/notifications/domain/**',
                '**/notifications/application/**',
                '**/payments/adapters/**',
                '**/payments/ports/**',
                '**/payments/domain/**',
                '**/payments/application/**',
                '**/logistics/adapters/**',
                '**/logistics/ports/**',
                '**/logistics/domain/**',
                '**/logistics/application/**',
                '**/trust/adapters/**',
                '**/trust/ports/**',
                '**/trust/domain/**',
                '**/trust/application/**',
                '**/ai-assistant/adapters/**',
                '**/ai-assistant/ports/**',
                '**/ai-assistant/domain/**',
                '**/ai-assistant/application/**',
                '**/backoffice/adapters/**',
                '**/backoffice/ports/**',
                '**/backoffice/domain/**',
                '**/backoffice/application/**',
              ],
              message:
                'Cross-module imports are only allowed via the module public API (modules/*/index.ts).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/bootstrap/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/modules/catalog/domain/**',
                '**/modules/catalog/application/**',
                '**/modules/catalog/ports/**',
                '**/modules/catalog/adapters/**',
                '**/modules/identity/domain/**',
                '**/modules/identity/application/**',
                '**/modules/identity/ports/**',
                '**/modules/identity/adapters/**',
                '**/modules/ordering/domain/**',
                '**/modules/ordering/application/**',
                '**/modules/ordering/ports/**',
                '**/modules/ordering/adapters/**',
                '**/modules/sync/domain/**',
                '**/modules/sync/application/**',
                '**/modules/sync/ports/**',
                '**/modules/sync/adapters/**',
                '**/modules/messaging/domain/**',
                '**/modules/messaging/application/**',
                '**/modules/messaging/ports/**',
                '**/modules/messaging/adapters/**',
                '**/modules/notifications/domain/**',
                '**/modules/notifications/application/**',
                '**/modules/notifications/ports/**',
                '**/modules/notifications/adapters/**',
                '**/modules/payments/domain/**',
                '**/modules/payments/application/**',
                '**/modules/payments/ports/**',
                '**/modules/payments/adapters/**',
                '**/modules/logistics/domain/**',
                '**/modules/logistics/application/**',
                '**/modules/logistics/ports/**',
                '**/modules/logistics/adapters/**',
                '**/modules/trust/domain/**',
                '**/modules/trust/application/**',
                '**/modules/trust/ports/**',
                '**/modules/trust/adapters/**',
                '**/modules/ai-assistant/domain/**',
                '**/modules/ai-assistant/application/**',
                '**/modules/ai-assistant/ports/**',
                '**/modules/ai-assistant/adapters/**',
                '**/modules/backoffice/domain/**',
                '**/modules/backoffice/application/**',
                '**/modules/backoffice/ports/**',
                '**/modules/backoffice/adapters/**',
              ],
              message: 'Bootstrap can only import module public APIs (modules/*/index.ts).',
            },
          ],
        },
      ],
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
