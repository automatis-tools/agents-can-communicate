import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { COHORT_FIELDS, buildProfile, compareProfiles, validProfile } from '../scripts/runner-profile.mjs';

const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, '..');
const script = path.join(repo, 'scripts/runner-profile.mjs');
const SECRET = 'ghs_secretvalue0123456789';
// The rejected #353 cohorts: one macos-latest label, different hosts and images.
const env = image => ({ GITHUB_RUN_ID: '40971214154', GITHUB_RUN_ATTEMPT: '1', GITHUB_JOB: 'measure',
  CI_WORKER: 'full-macos', RUNNER_OS: 'macOS', RUNNER_ARCH: 'ARM64', RUNNER_ENVIRONMENT: 'github-hosted',
  ImageOS: 'macos15', ImageVersion: image, GITHUB_TOKEN: SECRET, HOME: '/Users/runner' });
const observed = (model, cpus, gib, image) => ({ env: env(image), cpus: Array.from({ length: cpus }, () => ({ model })),
  memoryBytes: gib * 2 ** 30, release: '24.6.0', platform: 'darwin', arch: 'arm64', node: 'v24.22.1', npm: '11.19.1',
  commit: 'a'.repeat(40), tree: 'b'.repeat(40) });
const baseline = () => buildProfile(observed('Apple M1 (Virtual)', 3, 7, '20261013.0424.1'));
const shard = () => buildProfile(observed('Apple M2 Pro (Virtual)', 5, 14, '20261026.0455.2'));

test('a complete observation becomes a closed profile with nothing unavailable', () => {
  const profile = baseline();
  assert.deepEqual(profile, { schema: 1, kind: 'acc-runner-profile',
    run: { id: '40971214154', attempt: '1', job: 'measure', worker: 'full-macos' },
    source: { commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
    cohort: { platform: 'darwin', arch: 'arm64', release: '24.6.0', runnerOS: 'macOS', runnerArch: 'ARM64',
      runnerEnvironment: 'github-hosted', imageOS: 'macos15', imageVersion: '20261013.0424.1',
      cpuModel: 'Apple M1 (Virtual)', cpus: 3, memoryBytes: 7 * 2 ** 30, node: 'v24.22.1', npm: '11.19.1' },
    unavailable: [] });
  assert.ok(validProfile(profile));
});

test('missing or unusable facts are null and listed, never guessed', () => {
  const profile = buildProfile({ env: { GITHUB_RUN_ID: '0', ImageVersion: 'x y' }, cpus: [], memoryBytes: 0,
    release: '/Users/runner/os', platform: 'darwin', node: 'v24.22.1', npm: 'not-a-version', commit: 'HEAD' });
  assert.ok(validProfile(profile));
  assert.deepEqual(profile.unavailable, ['run.id', 'run.attempt', 'run.job', 'run.worker', 'source.commit',
    'source.tree', 'cohort.arch', 'cohort.release', 'cohort.runnerOS', 'cohort.runnerArch',
    'cohort.runnerEnvironment', 'cohort.imageOS', 'cohort.imageVersion', 'cohort.cpuModel', 'cohort.cpus',
    'cohort.memoryBytes', 'cohort.npm']);
  for (const item of profile.unavailable) {
    const [group, key] = item.split('.');
    assert.equal(profile[group][key], null, item);
  }
  assert.deepEqual(buildProfile().unavailable.length, 4 + 2 + COHORT_FIELDS.length);
});

test('profiles carry no credentials, environment dumps or absolute paths', () => {
  const raw = observed('/Users/runner/cpu', 2, 1, '20261013.0424.1');
  raw.env.CI_WORKER = 'C:\\Users\\runner';
  const text = JSON.stringify(buildProfile(raw));
  for (const leaked of [SECRET, 'GITHUB_TOKEN', 'HOME', '/Users/runner', 'C:\\\\Users']) {
    assert.ok(!text.includes(leaked), `profile leaked ${leaked}`);
  }
  const profile = JSON.parse(text);
  assert.equal(profile.cohort.cpuModel, null);
  assert.equal(profile.run.worker, null);
});

test('consumers can identify every incomparable cohort difference', () => {
  assert.deepEqual(compareProfiles(baseline(), baseline()), { comparable: true, differences: [] });
  assert.deepEqual(compareProfiles(baseline(), shard()), { comparable: false,
    differences: ['different:imageVersion', 'different:cpuModel', 'different:cpus', 'different:memoryBytes'] });
  const rerun = baseline();
  rerun.run.attempt = '2';
  rerun.source.commit = 'c'.repeat(40);
  assert.equal(compareProfiles(baseline(), rerun).comparable, true, 'run and source are not host facts');
  const unknown = baseline();
  unknown.cohort.npm = null;
  assert.deepEqual(compareProfiles(baseline(), unknown), { comparable: false, differences: ['unavailable:npm'] });
  const extended = { ...baseline(), env: {} };
  assert.deepEqual(compareProfiles(baseline(), extended), { comparable: false, differences: ['invalid-profile'] });
  const nested = baseline();
  nested.cohort.cpus = { count: 3 };
  assert.deepEqual(compareProfiles(nested, baseline()), { comparable: false, differences: ['invalid-profile'] });
});

test('record writes the real runner profile into RUNNER_TEMP without following an existing link', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'acc-runner-profile-'));
  try {
    const victim = path.join(temp, 'victim.txt');
    await writeFile(victim, 'unchanged');
    await symlink(victim, path.join(temp, 'acc-runner-profile.json'));
    const childEnv = { ...process.env, ...env('20261013.0424.1'), RUNNER_TEMP: temp, GIT_DIR: '', GIT_WORK_TREE: '' };
    delete childEnv.NODE_TEST_CONTEXT;
    const { stdout } = await run(process.execPath, [script, 'record'], { cwd: repo, env: childEnv });
    assert.match(stdout, /^runner profile: .+ x\d+, \d+\.\d GiB, macos15 20261013\.0424\.1; unavailable: /);
    assert.equal(await readFile(victim, 'utf8'), 'unchanged');
    const file = path.join(temp, 'acc-runner-profile.json');
    assert.ok((await lstat(file)).isFile());
    const profile = JSON.parse(await readFile(file, 'utf8'));
    assert.ok(validProfile(profile));
    assert.ok(!JSON.stringify(profile).includes(SECRET));
    const head = (await run('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
    assert.equal(profile.source.commit, head);
    assert.equal(profile.run.worker, 'full-macos');
    assert.equal(profile.cohort.node, process.version);
    assert.equal(profile.cohort.cpus, (await import('node:os')).cpus().length);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('record refuses to guess a destination and compare reports through its exit code', async () => {
  const childEnv = { ...process.env };
  delete childEnv.RUNNER_TEMP; delete childEnv.NODE_TEST_CONTEXT;
  await assert.rejects(run(process.execPath, [script, 'record'], { cwd: repo, env: childEnv }),
    error => error.code === 1 && /RUNNER_TEMP/.test(error.stderr));
  const temp = await mkdtemp(path.join(tmpdir(), 'acc-runner-compare-'));
  try {
    const [a, b] = [path.join(temp, 'a.json'), path.join(temp, 'b.json')];
    await writeFile(a, JSON.stringify(baseline()));
    await writeFile(b, JSON.stringify(baseline()));
    assert.deepEqual(JSON.parse((await run(process.execPath, [script, 'compare', a, b])).stdout),
      { comparable: true, differences: [] });
    await writeFile(b, JSON.stringify(shard()));
    await assert.rejects(run(process.execPath, [script, 'compare', a, b]),
      error => error.code === 2 && JSON.parse(error.stdout).comparable === false);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
