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
  coverageThreshold['./src/modules/**/domain/**/*.ts'] = {
    lines: 90,
    functions: 90,
    branches: 90,
    statements: 90,
  };
}
if (hasSourceInLayer('application')) {
  coverageThreshold['./src/modules/**/application/**/*.ts'] = {
    lines: 80,
    functions: 80,
    branches: 80,
    statements: 80,
  };
}

module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.e2e-spec\\.ts$',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  testEnvironment: 'node',
  collectCoverageFrom: [
    'src/bootstrap/app.module.ts',
    'src/modules/**/domain/**/*.ts',
    'src/modules/**/application/**/*.ts',
    '!**/index.ts',
    '!**/.gitkeep',
    '!**/*fixture*/**',
  ],
  coverageReporters: ['text', 'lcov'],
  coverageThreshold,
};
