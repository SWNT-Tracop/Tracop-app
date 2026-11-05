const { readFile, rm } = require('node:fs/promises');
const { spawnSync } = require('node:child_process');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { createHash } = require('node:crypto');

const worktreeId = createHash('sha256').update(resolve(__dirname, '..')).digest('hex').slice(0, 12);

module.exports = async () => {
  const statePath = join(tmpdir(), `tracop-${worktreeId}-test-container.json`);
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
