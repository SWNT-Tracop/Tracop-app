/** @type {import('jest').Config} */
const fs = require('node:fs');
const path = require('node:path');

const hasSourceInLayer = (layer) => {
  const root = path.resolve('src/modules');
  if (!fs.existsSync(root)) return false;
  const visit = (directory) =>
    fs.readdirSync(directory, { withFileTypes: true }).some((entry) => {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) return !entry.name.includes('fixture') && visit(filename);
      return (
        filename.includes(`${path.sep}${layer}${path.sep}`) &&
        filename.endsWith('.ts') &&
        !entry.name.endsWith('index.ts')
      );
    });
  return visit(root);
};

const coverageThreshold = {
  global: { lines: 75, functions: 75, branches: 75, statements: 75 },
};
if (hasSourceInLayer('domain')) {
  coverageThreshold['./src/modules/identity/domain/**/*.ts'] = {
    lines: 90,
  };
}
if (hasSourceInLayer('application')) {
  coverageThreshold['./src/modules/identity/application/**/*.ts'] = {
    lines: 80,
  };
}
coverageThreshold['./src/modules/messaging/application/**/*.ts'] = { lines: 80 };

module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.(spec|contract-spec|e2e-spec|integration-spec)\\.ts$',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.spec.json' }] },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@tracop/contracts$': '<rootDir>/../../packages/contracts/src/index.ts',
  },
  globalSetup: '<rootDir>/test/global-setup.cjs',
  globalTeardown: '<rootDir>/test/global-teardown.cjs',
  setupFiles: ['<rootDir>/test/setup-env.cjs'],
  testEnvironment: 'node',
  testEnvironmentOptions: {
    customExportConditions: ['node', 'require', 'default'],
  },
  collectCoverageFrom: [
    'src/bootstrap/app.module.ts',
    'src/modules/identity/domain/**/*.ts',
    'src/modules/identity/application/**/*.ts',
    'src/modules/messaging/application/**/*.ts',
    'src/shared/kernel/**/*.ts',
    '!**/index.ts',
    '!**/.gitkeep',
    '!**/*fixture*/**',
  ],
  coverageReporters: ['text', 'lcov'],
  coverageThreshold,
};
