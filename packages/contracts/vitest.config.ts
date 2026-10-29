import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/index.ts', '**/*fixture*/**'],
      thresholds: { lines: 75, functions: 75, branches: 75, statements: 75 },
    },
  },
});
