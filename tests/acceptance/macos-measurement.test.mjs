import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { admitMeasurementContext, validateMeasurement, aggregateMeasurements, createMeasurementOutput, measurementEnvironment, runMeasurementCommand } from '../../scripts/macos-measurement.mjs';

// These synthetic fixtures exercise admission and accounting, never native speed.
const workload = { commit: 'b272ca474b229a84aa06fb25a5a0bf0ae44e245a', tree: '20ac4fa0d8f3362592c3dbcb66c25fe40af4bdf6' };
const controller = { commit: 'c'.repeat(40), tree: 'd'.repeat(40) };
// Static frozen cohort: no Git history or current-HEAD discovery dependency.
const frozen = JSON.parse(await readFile(new URL('../fixtures/macos-measurement-b272ca47.json', import.meta.url), 'utf8'));
const discovery = frozen.files;
function admission(attempt = '1') {
  return { env: { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'automatis-tools/agents-can-communicate',
    GITHUB_REF: 'refs/heads/measure/macos-shards-353', GITHUB_EVENT_NAME: 'push', GITHUB_SHA: controller.commit,
    GITHUB_RUN_ID: '401', GITHUB_RUN_ATTEMPT: attempt },
  event: { repository: { full_name: 'automatis-tools/agents-can-communicate' },
    ref: 'refs/heads/measure/macos-shards-353', before: '0'.repeat(40), after: controller.commit, created: true, deleted: false },
  head: controller.commit, platform: 'darwin', arch: 'arm64' };
}
function record(profile = 'baseline', attempt = '1') {
  const shard = profile === 'baseline' ? undefined : `${profile.at(-1)}/2`;
  const files = shard ? discovery.filter((_, i) => i % 2 === Number(profile.at(-1)) - 1) : discovery;
  const fileCount = files.length;
  const identity = { schema: 1, commit: workload.commit, tree: workload.tree, platform: 'darwin',
    node: 'v24.22.1', scope: 'full', ...(shard ? { shard } : {}), fileCount, concurrency: 4, fsyncMode: 'real' };
  const events = ['fingerprint', 'cache-lookup', 'packed-template', 'batch-execution', 'cleanup', 'total'].map(event =>
    ({ ...identity, event, durationMs: event === 'total' ? 100 : 10, result: ['fingerprint', 'cache-lookup'].includes(event) ? 'ci-disabled' : 'passed' }));
  const runtime = { node: 'v24.22.1', npm: '11.6.0', nodeExecutable: '/node/bin/node', npmCli: '/node/lib/node_modules/npm/bin/npm-cli.js' };
  return { schema: 1, kind: 'acc-macos-partition-experiment', status: 'passed', profile,
    context: admitMeasurementContext(admission(attempt)), controller, workload, after: { controller, workload }, runtime,
    host: { platform: 'darwin', arch: 'arm64', runnerOS: 'macOS', runnerArch: 'ARM64', environment: 'github-hosted',
      imageOS: 'macos26-arm64', imageVersion: '20261020.1', runnerName: `runner-${profile}`,
      hardware: { model: 'Apple M2', cpus: 3, memoryBytes: 14000000000, release: '25.0.0' } },
    discovery: [...discovery], manifest: { schema: 1, events, files: files.map(file => ({ file, durationMs: 1, success: true })),
      receiptDecision: { reused: false, reason: 'ci-disabled' }, resultCounts: { selected: fileCount, completed: fileCount, passed: fileCount, failed: 0 } },
    rawTimings: files.map(file => ({ file, durationMs: 1, success: true })),
    command: { executable: runtime.nodeExecutable, args: ['scripts/run-tests.mjs', ...(shard ? ['--shard', shard] : [])], exitCode: 0,
      environment: { CI: 'true', ACC_TEST_REAL_FSYNC: '1', ACC_TEST_FILE_CONCURRENCY: '4', ACC_TEST_TIMEOUT_MS: '300000',
        ACC_TEST_FILE_TIMEOUT_MS: '600000' } }, walls: { setupMs: 20, runnerMs: 120, wrapperMs: 150 } };
}
const copy = value => structuredClone(value);

test('creation push attempts 1 and 2 are admitted, preserving run identity', () => {
  for (const attempt of ['1', '2']) assert.equal(admitMeasurementContext(admission(attempt)).runAttempt, attempt);
});
for (const [name, change] of [
  ['main', x => { x.env.GITHUB_REF = x.event.ref = 'refs/heads/main'; }],
  ['ordinary PR', x => { x.env.GITHUB_EVENT_NAME = 'pull_request'; }],
  ['later branch push', x => { x.event.before = 'a'.repeat(40); x.event.created = false; }],
  ['third attempt', x => { x.env.GITHUB_RUN_ATTEMPT = '3'; }],
  ['noncanonical attempt', x => { x.env.GITHUB_RUN_ATTEMPT = '01'; }],
  ['wrong repository', x => { x.env.GITHUB_REPOSITORY = 'elsewhere/repo'; }],
  ['foreign event repository', x => { x.event.repository.full_name = 'elsewhere/repo'; }],
  ['mismatched event after', x => { x.event.after = 'b'.repeat(40); }],
  ['mismatched event ref', x => { x.event.ref = 'refs/heads/main'; }],
  ['deleted branch', x => { x.event.deleted = true; }],
  ['wrong checkout', x => { x.head = 'a'.repeat(40); }],
  ['local environment', x => { delete x.env.GITHUB_ACTIONS; }],
  ['missing run', x => { delete x.env.GITHUB_RUN_ID; }],
  ['non-macOS process', x => { x.platform = 'linux'; }],
  ['non-ARM process', x => { x.arch = 'x64'; }],
]) test(`context rejects ${name}`, () => {
  const input = admission(); change(input); assert.throws(() => admitMeasurementContext(input), /measurement/);
});

test('complete baseline and two exhaustive shards preserve actual profile walls', () => {
  const records = [record('shard-2'), record(), record('shard-1')];
  assert.equal(validateMeasurement(records[1]), records[1]);
  records[0].walls.runnerMs = 170; records[0].walls.wrapperMs = 200;
  const result = aggregateMeasurements(records);
  assert.equal(result.kind, 'acc-macos-partition-comparison');
  assert.equal(result.baseline.wrapperMs, 150);
  assert.equal(result.shards.maxWrapperMs, 200);
  assert.equal(result.shards.sumWrapperMs, 350);
  assert.equal(result.fileCount, 484);
  assert.ok(result.caveats.length > 0);
});
for (const [name, change] of [
  ['invalid profile', r => { r.profile = 'shard-3'; }],
  ['failed collection', r => { r.status = 'failed'; }],
  ['nonzero runner', r => { r.command.exitCode = 1; }],
  ['partial member set', r => { r.manifest.files.pop(); }],
  ['duplicate member', r => { r.manifest.files[1] = copy(r.manifest.files[0]); }],
  ['consistently duplicated members', r => { r.manifest.files[1] = copy(r.manifest.files[0]); r.rawTimings[1] = copy(r.rawTimings[0]); }],
  ['foreign member', r => { r.manifest.files[0].file = 'tests/foreign.test.mjs'; }],
  ['failed member', r => { r.manifest.files[0].success = false; }],
  ['failed raw timing', r => { r.rawTimings[0].success = false; }],
  ['raw timing drift', r => { r.rawTimings[0].durationMs++; }],
  ['raw timing duplication', r => { r.rawTimings[1] = copy(r.rawTimings[0]); }],
  ['wrong count', r => { r.manifest.resultCounts.completed--; }],
  ['missing total', r => { r.manifest.events.pop(); }],
  ['wrong terminal result', r => { r.manifest.events.at(-1).result = 'failed'; }],
  ['foreign event identity', r => { r.manifest.events[3].commit = controller.commit; }],
  ['wrong event runtime', r => { r.manifest.events[3].node = 'v24.4.0'; }],
  ['skipped durability', r => { r.manifest.events[3].fsyncMode = 'skipped'; }],
  ['wrong concurrency', r => { r.manifest.events[3].concurrency = 3; }],
  ['wrong scope', r => { r.manifest.events[3].scope = 'docs'; }],
  ['wrong shard', r => { r.manifest.events[3].shard = '2/2'; }],
  ['receipt reuse', r => { r.manifest.receiptDecision = { reused: true, reason: 'hit' }; }],
  ['reordered phases', r => { [r.manifest.events[0], r.manifest.events[1]] = [r.manifest.events[1], r.manifest.events[0]]; }],
  ['extra phase', r => { r.manifest.events.splice(3, 0, { ...r.manifest.events[3], event: 'package-smoke' }); }],
  ['negative duration', r => { r.manifest.files[0].durationMs = -1; }],
  ['wrong command', r => { r.command.args.push('--if-needed'); }],
  ['fsync override', r => { r.command.environment.ACC_TEST_REAL_FSYNC = '0'; }],
  ['Node override', r => { r.runtime.node = 'v24.4.0'; }],
  ['foreign npm', r => { r.runtime.npmCli = '/other/npm-cli.js'; }],
  ['workload substitution', r => { r.workload = { ...r.workload, commit: controller.commit }; }],
  ['post-run source drift', r => { r.after.workload.tree = controller.tree; }],
  ['non-ARM image', r => { r.host.imageOS = 'macos26'; }],
  ['missing image version', r => { delete r.host.imageVersion; }],
  ['short discovery', r => { r.discovery.pop(); }],
  ['consistently foreign discovery', r => {
    r.discovery = r.discovery.map((_, i) => `tests/foreign${String(i).padStart(3, '0')}.test.mjs`);
    r.manifest.files.forEach((item, i) => { item.file = r.discovery[i]; });
    r.rawTimings.forEach((item, i) => { item.file = r.discovery[i]; });
  }],
]) test(`record rejects ${name}`, () => {
  const input = copy(record()); change(input); assert.throws(() => validateMeasurement(input), /measurement/);
});
for (const [name, change] of [
  ['missing profile', rs => { rs.pop(); }],
  ['duplicate profile', rs => { rs[2] = copy(rs[1]); }],
  ['foreign run', rs => { rs[1].context.runId = '402'; }],
  ['mixed attempts', rs => { rs[1] = record('shard-1', '2'); }],
  ['mixed images', rs => { rs[1].host.imageVersion = 'other'; }],
  ['mixed npm versions', rs => { rs[1].runtime.npm = '11.7.0'; }],
  ['overlapping shard files', rs => { rs[2].manifest.files = copy(rs[1].manifest.files); }],
  ['mixed hardware', rs => { rs[1].host.hardware.cpus++; }],
  ['mixed controller source', rs => { rs[1].controller = { ...rs[1].controller, tree: 'e'.repeat(40) }; rs[1].after.controller = rs[1].controller; }],
  ['foreign discovery', rs => { rs[1].discovery[0] = 'packages/else.test.mjs'; }],
]) test(`comparison rejects ${name}`, () => {
  const inputs = [record(), record('shard-1'), record('shard-2')]; change(inputs);
  assert.throws(() => aggregateMeasurements(inputs), /measurement/);
});

test('real CLI refuses a forged native environment before running workload tests', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'acc-macos-measurement-unit-'));
  try {
    const workloadRepo = path.join(root, 'workload'); await mkdir(workloadRepo);
    const event = path.join(root, 'event.json'); await writeFile(event, JSON.stringify(admission().event));
    const output = path.join(root, 'output');
    const child = spawnSync(process.execPath, ['scripts/macos-measurement.mjs'], {
      cwd: path.resolve(import.meta.dirname, '../..'), encoding: 'utf8',
      env: { ...process.env, ...admission().env, GITHUB_EVENT_PATH: event, ACC_MACOS_MEASUREMENT_REPO: workloadRepo,
        ACC_MACOS_MEASUREMENT_OUTPUT: output, ACC_MACOS_MEASUREMENT_PROFILE: 'baseline',
        ACC_MACOS_MEASUREMENT_WORKLOAD_SHA: workload.commit }, timeout: 10000,
    });
    assert.equal(child.status, 1, child.stderr);
    assert.match(child.stderr, /measurement/);
    await assert.rejects(readFile(path.join(output, 'measurement.json')), { code: 'ENOENT' });
    const failure = JSON.parse(await readFile(path.join(output, 'failure.json'), 'utf8'));
    assert.equal(failure.status, 'failed'); assert.equal(failure.runId, '401');
    await assert.rejects(readFile(path.join(output, 'runner.stdout.log')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('runner environment matches ordinary driver sanitation and preserves real fsync/watchdogs', () => {
  const child = measurementEnvironment({ PATH: '/bin', GIT_DIR: '', GIT_WORK_TREE: '/elsewhere',
    ACC_TEST_PACKED_TEMPLATE: '/stale', ACC_TEST_FILE_CONCURRENCY: '99', NODE_OPTIONS: '--import=/bad', NODE_TEST_CONTEXT: 'child' });
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'ACC_TEST_PACKED_TEMPLATE', 'NODE_OPTIONS', 'NODE_TEST_CONTEXT']) assert.equal(child[key], undefined);
  assert.equal(child.CI, 'true'); assert.equal(child.ACC_TEST_REAL_FSYNC, '1');
  assert.equal(child.ACC_TEST_FILE_CONCURRENCY, '4');
  assert.equal(child.ACC_TEST_TIMEOUT_MS, '300000'); assert.equal(child.ACC_TEST_FILE_TIMEOUT_MS, '600000');
});
test('output is fresh, outside both trees, and cannot escape through a parent symlink', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'acc-macos-output-unit-'));
  try {
    const checkouts = [path.join(root, 'controller'), path.join(root, 'workload')];
    await Promise.all(checkouts.map(directory => mkdir(directory)));
    const existing = path.join(root, 'existing'); await createMeasurementOutput(existing, checkouts);
    await writeFile(path.join(existing, 'sentinel'), 'owned by another observation');
    await assert.rejects(createMeasurementOutput(existing, checkouts), { code: 'EEXIST' });
    assert.equal(await readFile(path.join(existing, 'sentinel'), 'utf8'), 'owned by another observation');
    await assert.rejects(createMeasurementOutput(path.join(existing, 'inside'), [existing, checkouts[1]]), /measurement/);
    await symlink(existing, path.join(root, 'link'));
    await assert.rejects(createMeasurementOutput(path.join(root, 'link', 'inside'), [existing, checkouts[1]]), /measurement/);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('command capture retains separate stdout/stderr and the real nonzero exit', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'acc-macos-command-unit-'));
  try {
    const code = await runMeasurementCommand(process.execPath,
      ['-e', "process.stdout.write('real stdout'); process.stderr.write('real stderr'); process.exitCode=7"],
      { cwd: root, env: process.env, output: root, prefix: 'failure' });
    assert.equal(code, 7);
    assert.equal(await readFile(path.join(root, 'failure.stdout.log'), 'utf8'), 'real stdout');
    assert.equal(await readFile(path.join(root, 'failure.stderr.log'), 'utf8'), 'real stderr');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('interruption rejects capture while preserving completed diagnostic bytes', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'acc-macos-cancel-unit-'));
  const abort = new AbortController();
  let result;
  try {
    result = runMeasurementCommand(process.execPath, ['-e', "process.stdout.write('started'); setInterval(()=>{},1000)"],
      { cwd: root, env: process.env, output: root, prefix: 'cancel', signal: abort.signal })
      .then(code => ({ code }), error => ({ error }));
    let bytes = '';
    for (let i = 0; i < 100 && bytes !== 'started'; i++) {
      bytes = await readFile(path.join(root, 'cancel.stdout.log'), 'utf8').catch(() => '');
      if (bytes !== 'started') await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(bytes, 'started'); abort.abort();
    assert.match((await result).error?.message ?? '', /interrupted/);
    assert.equal(await readFile(path.join(root, 'cancel.stdout.log'), 'utf8'), 'started');
  } finally { abort.abort(); await result; await rm(root, { recursive: true, force: true }); }
});


test('offline Darwin records keep POSIX installation paths under Windows host semantics', t => {
  const originalPosix = path.posix;
  // Keep the real POSIX boundary available while reproducing Windows defaults.
  path.posix = { ...originalPosix };
  t.after(() => { path.posix = originalPosix; });
  t.mock.method(path, 'isAbsolute', path.win32.isAbsolute);
  t.mock.method(path, 'dirname', path.win32.dirname);
  t.mock.method(path, 'join', path.win32.join);
  const records = [record(), record('shard-1'), record('shard-2')];
  assert.equal(validateMeasurement(records[0]), records[0]);
  assert.equal(aggregateMeasurements(records).fileCount, 484);
  const foreign = copy(records[0]);
  foreign.runtime.nodeExecutable = String.raw`C:\node\bin\node.exe`;
  foreign.runtime.npmCli = String.raw`C:\node\lib\node_modules\npm\bin\npm-cli.js`;
  foreign.command.executable = foreign.runtime.nodeExecutable;
  assert.throws(() => validateMeasurement(foreign), /Node\/npm installation/);
});
test('Windows cancellation requests fail before opening logs or spawning a child', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'acc-macos-unsupported-unit-'));
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' });
    const marker = path.join(root, 'spawned');
    await assert.rejects(runMeasurementCommand(process.execPath,
      ['-e', "require('node:fs').writeFileSync(process.argv[1], 'spawned')", marker],
      { cwd: root, env: process.env, output: root, prefix: 'unsupported', signal: new AbortController().signal }),
    /Windows cancellation unsupported/);
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(root, 'unsupported.stdout.log')), { code: 'ENOENT' });
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
    await rm(root, { recursive: true, force: true });
  }
});
