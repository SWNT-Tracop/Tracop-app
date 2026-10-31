const { readFile, rm } = require('node:fs/promises');
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

module.exports = async () => {
  const statePath = join(tmpdir(), 'tracop-identity-test-container.json');
  try {
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    if (state.containerId) {
      const result = spawnSync('docker', ['--context', 'default', 'rm', '-f', state.containerId], {
        stdio: 'ignore',
      });
      if (result.status !== 0)
        throw new Error('Could not remove the PostgreSQL Testcontainers container.');
    }
  } finally {
    await rm(statePath, { force: true });
  }
};
