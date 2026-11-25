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
  coverageThreshold['./src/modules/catalog/domain/**/*.ts'] = {
    lines: 90,
  };
}
if (hasSourceInLayer('application')) {
  coverageThreshold['./src/modules/identity/application/**/*.ts'] = {
    lines: 80,
  };
  coverageThreshold['./src/modules/catalog/application/**/*.ts'] = {
    lines: 80,
  };
  coverageThreshold['./src/modules/ordering/application/**/*.ts'] = {
    lines: 80,
  };
  coverageThreshold['./src/modules/logistics/application/**/*.ts'] = {
    lines: 80,
  };
  coverageThreshold['./src/modules/payments/application/**/*.ts'] = {
    lines: 80,
  };
  coverageThreshold['./src/modules/notifications/application/**/*.ts'] = {
    lines: 80,
  };
  coverageThreshold['./src/modules/backoffice/application/**/*.ts'] = {
    lines: 80,
  };
  coverageThreshold['./src/modules/trust/application/**/*.ts'] = {
    lines: 80,
  };
  coverageThreshold['./src/modules/ai-assistant/application/**/*.ts'] = {
    lines: 80,
  };
  coverageThreshold['./src/modules/recommendations/application/**/*.ts'] = {
    lines: 80,
  };
}
if (hasSourceInLayer('domain')) {
  coverageThreshold['./src/modules/ordering/domain/**/*.ts'] = {
    lines: 90,
  };
  coverageThreshold['./src/modules/logistics/domain/**/*.ts'] = {
    lines: 90,
  };
  coverageThreshold['./src/modules/payments/domain/**/*.ts'] = {
    lines: 90,
  };
  coverageThreshold['./src/modules/notifications/domain/**/*.ts'] = {
    lines: 90,
  };
  coverageThreshold['./src/modules/backoffice/domain/**/*.ts'] = {
    lines: 90,
  };
  coverageThreshold['./src/modules/trust/domain/**/*.ts'] = {
    lines: 90,
  };
  coverageThreshold['./src/modules/ai-assistant/domain/**/*.ts'] = {
    lines: 90,
  };
  coverageThreshold['./src/modules/recommendations/domain/**/*.ts'] = {
    lines: 90,
  };
}
coverageThreshold['./src/shared/auth/**/*.ts'] = { lines: 80 };
coverageThreshold['./src/modules/identity/domain/provider-profile.ts'] = { lines: 90 };
coverageThreshold['./src/modules/identity/application/provider-profile-service.ts'] = { lines: 80 };
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
    'src/bootstrap/otp-delivery.module.ts',
    'src/bootstrap/worker-jobs.ts',
    'src/bootstrap/worker-lifecycle.ts',
    'src/modules/identity/domain/**/*.ts',
    'src/modules/identity/application/**/*.ts',
    'src/modules/catalog/domain/**/*.ts',
    'src/modules/catalog/application/**/*.ts',
    'src/modules/ordering/domain/**/*.ts',
    'src/modules/ordering/application/**/*.ts',
    'src/modules/logistics/domain/**/*.ts',
    'src/modules/logistics/application/**/*.ts',
    'src/modules/payments/domain/**/*.ts',
    'src/modules/payments/application/**/*.ts',
    'src/modules/notifications/domain/**/*.ts',
    'src/modules/notifications/application/**/*.ts',
    'src/modules/backoffice/domain/**/*.ts',
    'src/modules/backoffice/application/**/*.ts',
    'src/modules/trust/domain/**/*.ts',
    'src/modules/trust/application/**/*.ts',
    'src/modules/ai-assistant/domain/**/*.ts',
    'src/modules/ai-assistant/application/**/*.ts',
    'src/modules/recommendations/domain/**/*.ts',
    'src/modules/recommendations/application/**/*.ts',
    'src/modules/messaging/application/**/*.ts',
    'src/modules/sync/application/**/*.ts',
    'src/shared/auth/**/*.ts',
    'src/shared/kernel/**/*.ts',
    '!**/index.ts',
    '!**/*.spec.ts',
    '!**/.gitkeep',
    '!**/*fixture*/**',
  ],
  coverageReporters: ['text', 'lcov'],
  coverageThreshold,
};
