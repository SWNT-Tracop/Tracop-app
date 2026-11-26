import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve(__dirname, '../../../scripts/deploy/aws-demo.sh');
const sha = 'a'.repeat(40);
type Call = { command: string; args: string[] };

// Execute the real shell orchestration against deterministic external command doubles.
// CI runs on Linux; native Windows cannot exercise flock or POSIX permissions.
const linuxDescribe = process.platform === 'linux' ? describe : describe.skip;
linuxDescribe('AWS demo deployment recovery', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tracop-deploy-'));
    mkdirSync(join(root, 'bin'));
    mkdirSync(join(root, 'app'));
    const mock = `#!/usr/bin/env -S node --
const fs = require('node:fs');
const path = require('node:path');
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify({command,args})+'\\n');
const has = x => args.includes(x);
const fail = phase => { if(process.env.FAIL === phase) process.exit(1); };
if(command === 'git' && args[0] === 'rev-parse') console.log(args[1] === 'HEAD' || process.env.FAIL === 'stale' ? 'b'.repeat(40) : process.env.DEPLOY_SHA);
if(command === 'curl') console.log(JSON.stringify({status:'ready'}));
if(command === 'docker') {
  if(args[0] === 'build') fail('build');
  if(args[0] === 'inspect') console.log(args[2] === '{{.Image}}' ? 'sha256:previous-'+args[3] : 'tracop-api:'+process.env.DEPLOY_SHA);
  if(args[0] === 'run') fail('readiness');
  if(args[0] === 'compose') {
    if(has('config')) console.log('services: {}');
    if(has('ps')) console.log(args.at(-1));
    if(has('exec')) console.log('synthetic-backup');
    if(has('run')) fail('migration');
    if(has('up') && !args.some(x => x.endsWith('previous-images.yml'))) fail('activation');
  }
}
`;
    for (const command of ['git', 'docker', 'curl', 'sleep']) {
      writeFileSync(join(root, 'bin', command), mock, { mode: 0o755 });
    }
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function run(failure = '') {
    const result = spawnSync('bash', [script], {
      env: {
        ...process.env,
        PATH: `${join(root, 'bin')}:${process.env.PATH}`,
        DEPLOY_SHA: sha,
        PUBLIC_URL: 'https://demo.example.test',
        APP_DIR: join(root, 'app'),
        STATE_DIR: join(root, 'state'),
        LEGACY_OVERRIDE: join(root, 'absent.yml'),
        SWAGGER_DIR: join(root, 'absent-swagger'),
        CALLS: join(root, 'calls'),
        FAIL: failure,
      },
      encoding: 'utf8',
      timeout: 20000,
    });
    if (result.status !== 0 && failure === '') {
      throw new Error(`Deployment failed (${result.status}): ${result.stderr}`);
    }
    const calls = readFileSync(join(root, 'calls'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Call);
    return { result, calls };
  }

  it('backs up, migrates without seed, then promotes only API and worker', () => {
    const { result, calls } = run();
    expect(result.status).toBe(0);
    const docker = calls.filter((call) => call.command === 'docker');
    const backup = docker.findIndex((call) => call.args.includes('exec'));
    const migration = docker.findIndex((call) => call.args.includes('setup'));
    const activation = docker.findIndex((call) => call.args.includes('up'));
    expect(backup).toBeGreaterThan(-1);
    expect(migration).toBeGreaterThan(backup);
    expect(activation).toBeGreaterThan(migration);
    expect(docker[migration]!.args.slice(-3)).toEqual(['setup', 'node', 'dist/drizzle/migrate.js']);
    expect(docker[activation]!.args.slice(-2)).toEqual(['api', 'worker']);
    expect(docker[activation]!.args).toEqual(
      expect.arrayContaining(['--no-deps', '--no-build', '--wait']),
    );
    expect(readFileSync(join(root, 'state/active.yml'), 'utf8')).toContain(
      `image: tracop-api:${sha}`,
    );
  });

  it.each(['build', 'migration'])('leaves running services alone when %s fails', (phase) => {
    const { result, calls } = run(phase);
    expect(result.status).not.toBe(0);
    expect(calls.filter((call) => call.command === 'docker' && call.args.includes('up'))).toEqual(
      [],
    );
    expect(calls.at(-1)).toEqual({
      command: 'git',
      args: ['checkout', '--detach', 'b'.repeat(40)],
    });
  });

  it.each(['activation', 'readiness'])('restores immutable old images when %s fails', (phase) => {
    const { result, calls } = run(phase);
    expect(result.status).not.toBe(0);
    const updates = calls.filter((call) => call.command === 'docker' && call.args.includes('up'));
    expect(updates).toHaveLength(2);
    const recovery = updates[1]!.args.find((arg) => arg.endsWith('previous-images.yml'))!;
    expect(readFileSync(recovery, 'utf8')).toContain('image: sha256:previous-api');
    expect(readFileSync(recovery, 'utf8')).toContain('image: sha256:previous-worker');
  });

  it('skips superseded commits before building or touching the database', () => {
    const { result, calls } = run('stale');
    expect(result.status).toBe(0);
    expect(calls.some((call) => call.command === 'docker')).toBe(false);
  });
});
