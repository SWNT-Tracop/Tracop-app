/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.e2e-spec\\.ts$',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  testEnvironment: 'node',
  collectCoverageFrom: ['src/modules/**/domain/**/*.ts', 'src/modules/**/application/**/*.ts', '!**/index.ts', '!**/.gitkeep'],
  coverageThreshold: { global: { lines: 75, functions: 75, branches: 75, statements: 75 }, './src/modules/**/domain/**/*.ts': { lines: 90 }, './src/modules/**/application/**/*.ts': { lines: 80 } },
};
