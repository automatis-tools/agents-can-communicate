import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { createPackedAcc } from '../../tests/helpers/packed-acc.mjs';
// Manual real-client capture. No authentication or model turn is used.
// Usage: node scripts/e2e/codex-prerequisite-setup.mjs ARCHIVE RESULT_JSON SOURCE_COMMIT
if (!process.argv[2] || !process.argv[3]) throw new Error('An exact archive and result path are required');
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Only darwin-arm64 is captured');
const archive = path.resolve(process.argv[2]), output = path.resolve(process.argv[3]);
const run = promisify(execFile), cleanups = [];
const p = await createPackedAcc({ after: fn => cleanups.push(fn) });
const codexHome = path.join(p.clientHome, '.codex'), vendor = path.join(p.root, 'codex-npm');
const evidence = { capturedAt: new Date().toISOString(), platform: `${process.platform}-${process.arch}`,
  scope: 'Exact packed ACC, real npm Codex 0.154.0, absent standalone package, no auth or model sessions.',
  sourceCommit: process.argv[4] ?? null,
  root: p.root, archive, steps: [] };
const exists = file => lstat(file).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; });
const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');

try {
  await run('npm', ['install', '--prefix', p.consumer, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', archive],
    { env: process.env, timeout: 60000 });
  evidence.accVersion = JSON.parse(await readFile(path.join(p.installed, 'package.json'), 'utf8')).version;
  evidence.captureScriptSha256 = await hash(import.meta.filename);
  const entries = (await run('tar', ['-tzf', archive])).stdout.split('\n')
    .filter(name => name.startsWith('package/') && !name.endsWith('/'));
  evidence.fileComparisons = [];
  for (const name of entries) {
    const relative = name.slice(8);
    const sourceRelative = relative.replace(/^node_modules\/@agents-can-communicate\/([^/]+)\//, 'packages/$1/');
    const bytes = (await run('tar', ['-xzOf', archive, name], { encoding: 'buffer' })).stdout;
    assert.deepEqual(await readFile(path.join(p.installed, relative)), bytes, name);
    assert.deepEqual(await readFile(path.join(p.repo, sourceRelative)), bytes, name);
    evidence.fileComparisons.push({ path: relative, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  await mkdir(vendor);
  await run('npm', ['install', '--prefix', vendor, '--ignore-scripts', '--no-audit', '--no-fund', '@openai/codex@0.154.0'],
    { env: process.env, timeout: 180000, maxBuffer: 1048576 });
  evidence.npmCodex = JSON.parse(await readFile(path.join(vendor, 'node_modules/@openai/codex/package.json'), 'utf8')).version;
  const cli = await realpath(path.join(vendor, 'node_modules/.bin/codex'));
  evidence.cli = cli; evidence.originalCliSha256 = await hash(cli);
  for (const key of Object.keys(p.env)) delete p.env[key];
  Object.assign(p.env, { HOME: p.clientHome, CODEX_HOME: codexHome, ACC_DATA_HOME: p.dataHome,
    ACC_NO_UPDATE_CHECK: '1', SHELL: '/bin/zsh', LANG: 'en_US.UTF-8',
    PATH: `${path.join(vendor, 'node_modules/.bin')}:${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    TMPDIR: path.join(p.root, 'tmp'), XDG_CONFIG_HOME: path.join(p.root, 'config'),
    XDG_CACHE_HOME: path.join(p.root, 'cache'), XDG_DATA_HOME: path.join(p.root, 'vendor-data') });
  await mkdir(p.env.TMPDIR);
  const current = path.join(codexHome, 'packages/standalone/current');
  const pidPath = path.join(codexHome, 'app-server-daemon/app-server.pid');
  evidence.archiveSha256 = await hash(archive);
  const preview = await p.acc(['install', '--adapter', 'codex', '--delivery', 'actionable', '--dry-run']);
  evidence.preview = preview;
  assert.equal(await exists(current), false);
  assert.equal(await exists(pidPath), false);
  evidence.steps.push('preview did not download or start');
  const install = await p.acc(['install', '--adapter', 'codex', '--delivery', 'actionable']);
  evidence.install = install;
  const setup = install.operations[0].nativeServiceSetup;
  assert.equal(setup.state, 'ready');
  assert.equal(setup.installedPrerequisite, true);
  assert.equal(setup.started, true);
  evidence.steps.push('npm Codex acquired matching standalone and verified a started service');
  const beforeRepeat = await readFile(pidPath, 'utf8');
  const repeat = await p.acc(['install', '--adapter', 'codex']);
  evidence.repeat = repeat;
  assert.equal(repeat.operations[0].nativeServiceSetup.state, 'ready');
  assert.equal(repeat.operations[0].nativeServiceSetup.started, false);
  assert.equal(await readFile(pidPath, 'utf8'), beforeRepeat);
  evidence.steps.push('repeat retained service identity without installation or start');
  const saved = JSON.parse(await readFile(path.join(p.dataHome, 'acc/installs.json'), 'utf8')).installs[0];
  assert.equal(saved.deliveryDecision.installPrerequisites, true);
  evidence.savedDecision = saved.deliveryDecision;
  evidence.doctor = await p.acc(['doctor']);
  assert.equal(await hash(cli), evidence.originalCliSha256);
  const profiles = ['.profile', '.zprofile', '.zshrc', '.bashrc', '.bash_profile'];
  for (const name of profiles) assert.equal(await exists(path.join(p.clientHome, name)), false);
  evidence.steps.push('npm command and shell profiles unchanged');
  evidence.success = true;
} catch (e) {
  evidence.error = { message: e.message, code: e.code, stdout: e.stdout, stderr: e.stderr };
  process.exitCode = 1;
} finally {
  const managed = path.join(codexHome, 'packages/standalone/current/bin/codex');
  const pid = path.join(codexHome, 'app-server-daemon/app-server.pid');
  if (await exists(managed) && await exists(pid)) {
    try {
      const stopped = await run(managed, ['app-server', 'daemon', 'stop'],
        { cwd: p.clientHome, env: p.env, timeout: 20000 });
      evidence.cleanup = JSON.parse(stopped.stdout);
    } catch (e) { evidence.cleanupError = e.message; process.exitCode = 1; }
  }
  await writeFile(output, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ output, root: p.root, success: evidence.success,
    steps: evidence.steps, error: evidence.error, cleanup: evidence.cleanup }, null, 2));
  if (!evidence.cleanupError) for (const cleanup of cleanups.reverse()) await cleanup();
}
