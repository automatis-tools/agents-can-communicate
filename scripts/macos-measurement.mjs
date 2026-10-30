#!/usr/bin/env node
// Experimental capture and offline admission share one record contract so native
// collection cannot silently use weaker guards than comparison of its artifacts.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { checkoutMatchesCommit } from './push-tree-check.mjs';
import { stopPushProcessTree } from './push-process-tree.mjs';

const run = promisify(execFile);
const REPOSITORY = 'automatis-tools/agents-can-communicate';
const REF = 'refs/heads/measure/macos-shards-353';
const FAILED_CONTROLLER = 'ff9c5f96817dad463f15fe9bbf4b912114c1bffc';
const ENVIRONMENT_REPAIR_CONTROLLER = 'f3f01638056ca6719b440c6fb509bd08cc6e59cc';
const WORKLOAD = { commit: 'b272ca474b229a84aa06fb25a5a0bf0ae44e245a', tree: '20ac4fa0d8f3362592c3dbcb66c25fe40af4bdf6' };
const PROFILES = ['baseline', 'shard-1', 'shard-2'];
const CHILD_ENV = { CI: 'true', ACC_TEST_TIMEOUT_MS: '300000', ACC_TEST_FILE_TIMEOUT_MS: '600000' };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const positive = value => typeof value === 'string' && /^[1-9]\d*$/.test(value);
const oid = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const duration = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const text = value => typeof value === 'string' && value.trim().length > 0;
const requireValid = (condition, detail) => { if (!condition) throw Error(`macos-measurement-invalid: ${detail}`); };
const shardFor = profile => profile === 'baseline' ? undefined : `${profile.at(-1)}/2`;
const argsFor = profile => ['scripts/run-tests.mjs', ...(profile === 'baseline' ? [] : ['--shard', shardFor(profile)])];
function contextValid(c, head, platform, arch) {
  const creation = c.created === true && c.before === '0'.repeat(40);
  const repair = c.created === false && [FAILED_CONTROLLER, ENVIRONMENT_REPAIR_CONTROLLER].includes(c.before) && c.sha !== c.before;
  requireValid(c.actions === 'true' && c.repository === REPOSITORY && c.eventRepository === REPOSITORY
    && c.ref === REF && c.eventRef === REF && c.eventName === 'push' && (creation || repair)
    && c.deleted === false && oid(c.sha) && c.after === c.sha && head === c.sha
    && positive(c.runId) && ['1', '2'].includes(c.runAttempt) && platform === 'darwin' && arch === 'arm64', 'creation-or-exact-repair push context');
  return c;
}
export function admitMeasurementContext({ env, event, head, platform, arch }) {
  return contextValid({ actions: env.GITHUB_ACTIONS, repository: env.GITHUB_REPOSITORY, eventRepository: event?.repository?.full_name,
    ref: env.GITHUB_REF, eventRef: event?.ref, eventName: env.GITHUB_EVENT_NAME, sha: env.GITHUB_SHA,
    before: event?.before, after: event?.after, created: event?.created, deleted: event?.deleted,
    runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT }, head, platform, arch);
}
function members(files, selected) {
  requireValid(Array.isArray(files) && files.length === selected.length
    && files.every(item => item && text(item.file) && duration(item.durationMs) && item.success === true)
    && same(files.map(item => item.file).sort(), selected), 'exact successful membership');
}
function validateNativeTools(runtime, h) {
  requireValid(runtime?.node === 'v24.22.1' && /^\d+\.\d+\.\d+$/.test(runtime.npm)
    && text(runtime.nodeExecutable) && path.posix.isAbsolute(runtime.nodeExecutable)
    && runtime.npmCli === path.posix.join(path.posix.dirname(path.posix.dirname(runtime.nodeExecutable)), 'lib/node_modules/npm/bin/npm-cli.js'), 'Node/npm installation');

  requireValid(h.platform === 'darwin' && h.arch === 'arm64' && h.runnerOS === 'macOS' && h.runnerArch === 'ARM64' && h.environment === 'github-hosted'
    && /^macos[1-9]\d*$/.test(h.imageOS) && text(h.imageVersion) && text(h.runnerName)
    && text(h.hardware?.model) && Number.isSafeInteger(h.hardware.cpus) && h.hardware.cpus > 0
    && Number.isSafeInteger(h.hardware.memoryBytes) && h.hardware.memoryBytes > 0 && text(h.hardware.release), 'native image/hardware');
}
function validateDiscovery(files) {
  requireValid(Array.isArray(files) && files.length === 484
    && files.every(file => /^(tests|packages)\/.+\.test\.mjs$/.test(file)
      && !file.includes('\\') && !file.includes(':') && file.split('/').every(p => p && p !== '.' && p !== '..'))
    && same(files, [...new Set(files)].sort())
    && createHash('sha256').update(JSON.stringify(files)).digest('hex') === '62d7454e9cfdc788232445f71c25359127c9275c3a1c20761f590b432bc8115c', 'frozen full discovery');
}
export function validateMeasurement(r) {
  requireValid(r?.schema === 1 && r.kind === 'acc-macos-partition-experiment' && r.status === 'passed'
    && PROFILES.includes(r.profile), 'experimental profile/status');
  requireValid(r.controller && oid(r.controller.commit) && oid(r.controller.tree) && r.context && r.host, 'controller identity');
  contextValid(r.context, r.controller.commit, r.host.platform, r.host.arch);
  requireValid(same(r.workload, WORKLOAD) && same(r.after, { controller: r.controller, workload: r.workload }), 'immutable clean sources');
  validateNativeTools(r.runtime, r.host);
  validateDiscovery(r.discovery);
  const selected = r.profile === 'baseline' ? r.discovery : r.discovery.filter((_, index) => index % 2 === Number(r.profile.at(-1)) - 1);
  const m = r.manifest;
  requireValid(m?.schema === 1 && same(m.receiptDecision, { reused: false, reason: 'ci-disabled' })
    && same(m.resultCounts, { selected: selected.length, completed: selected.length, passed: selected.length, failed: 0 }), 'counts/no receipt reuse');
  members(m.files, selected); members(r.rawTimings, selected);
  const ordered = files => [...files].sort((a, b) => a.file.localeCompare(b.file));
  requireValid(same(ordered(m.files), ordered(r.rawTimings)), 'raw/manifest timing consistency');
  requireValid(Array.isArray(m.events) && m.events.length >= 6 && m.events.at(-1).event === 'total', 'terminal runner event');
  const sequence = m.events.map(e => e.event);
  requireValid(same(sequence.slice(0, 3), ['fingerprint', 'cache-lookup', 'packed-template'])
    && same(sequence.slice(-2), ['cleanup', 'total'])
    && sequence.slice(3, -2).every(name => name === 'batch-execution'), 'ordered runner phases');
  const counts = new Map(); let batches = 0; let phasesMs = 0;
  for (const e of m.events) {
    requireValid(e.schema === 1 && e.commit === r.workload.commit && e.tree === r.workload.tree
      && e.platform === 'darwin' && e.node === r.runtime.node && e.scope === 'full' && e.fsyncMode === 'real'
      && e.concurrency === 4 && e.shard === shardFor(r.profile) && duration(e.durationMs), 'runner event identity/runtime');
    const cache = ['fingerprint', 'cache-lookup'].includes(e.event);
    requireValid(e.result === (cache ? 'ci-disabled' : 'passed'), 'successful runner phases');
    counts.set(e.event, (counts.get(e.event) ?? 0) + 1);
    if (e.event === 'batch-execution') {
      requireValid(Number.isSafeInteger(e.fileCount) && e.fileCount > 0, 'batch count'); batches += e.fileCount;
    } else requireValid(e.fileCount === selected.length, 'phase count');
    if (e.event !== 'total') phasesMs += e.durationMs;
  }
  const singles = ['fingerprint', 'cache-lookup', 'packed-template', 'cleanup', 'total'];
  requireValid(singles.every(name => counts.get(name) === 1) && counts.get('batch-execution') > 0
    && [...counts.keys()].every(name => singles.includes(name) || name === 'batch-execution') && batches === selected.length
    && m.events.at(-1).durationMs + 0.001 >= phasesMs, 'complete runner phases');
  requireValid(r.command?.executable === r.runtime.nodeExecutable && same(r.command.args, argsFor(r.profile))
    && r.command.exitCode === 0 && same(r.command.environment, CHILD_ENV), 'exact runner execution');
  requireValid(r.walls && ['setupMs', 'runnerMs', 'wrapperMs'].every(key => duration(r.walls[key]))
    && r.walls.runnerMs >= m.events.at(-1).durationMs && r.walls.wrapperMs >= r.walls.setupMs + r.walls.runnerMs, 'wall accounting');
  return r;
}
export function aggregateMeasurements(records) {
  requireValid(Array.isArray(records) && records.length === 3, 'three profiles required');
  records.forEach(validateMeasurement);
  requireValid(same(records.map(r => r.profile).sort(), [...PROFILES].sort()), 'one of each profile required');
  const baseline = records.find(r => r.profile === 'baseline');
  const common = r => ({ context: r.context, controller: r.controller, workload: r.workload, runtime: r.runtime,
    image: { imageOS: r.host.imageOS, imageVersion: r.host.imageVersion, platform: r.host.platform, arch: r.host.arch,
      hardware: r.host.hardware }, discovery: r.discovery });
  requireValid(records.every(r => same(common(r), common(baseline))), 'matching trial/source/runtime/image');
  const shards = ['shard-1', 'shard-2'].map(profile => records.find(r => r.profile === profile));
  const files = shards.flatMap(r => r.manifest.files.map(item => item.file));
  requireValid(new Set(files).size === files.length && same(files.sort(), baseline.discovery), 'disjoint exhaustive shards');
  const times = r => ({ profile: r.profile, ...r.walls, phases: r.manifest.events.map(e => ({ event: e.event, durationMs: e.durationMs })) });
  return { schema: 1, kind: 'acc-macos-partition-comparison', context: baseline.context, controller: baseline.controller,
    workload: baseline.workload, fileCount: baseline.discovery.length, baseline: times(baseline),
    shards: { profiles: shards.map(times), maxWrapperMs: Math.max(...shards.map(r => r.walls.wrapperMs)),
      sumWrapperMs: shards.reduce((total, r) => total + r.walls.wrapperMs, 0) },
    caveats: ['Experimental evidence only; no ordinary execution proof or reusable receipt.',
      'Native job/queue timing must be joined from GitHub API; wrapper max is not whole workflow time.',
      'Authorized launches are bounded observations, not population or billed-cost estimates.'] };
}
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const writeJson = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
// Retain only named scalar observations. This artifact records an observation,
// not successful admission, and survives any following metadata rejection.
export async function retainAndValidatePreflight(output, observation) {
  const select = (input, keys) => Object.fromEntries(keys.map(key => {
    const value = input?.[key];
    return [key, ['string', 'boolean'].includes(typeof value) || (typeof value === 'number' && Number.isFinite(value)) ? value : null];
  }));
  const preflight = { schema: 1, kind: 'acc-macos-partition-preflight', status: 'observed',
    profile: select(observation, ['profile']).profile,
    context: select(observation.context, ['actions', 'repository', 'eventRepository', 'ref', 'eventRef', 'eventName',
      'sha', 'before', 'after', 'created', 'deleted', 'runId', 'runAttempt']),
    controller: select(observation.controller, ['commit', 'tree']), workload: select(observation.workload, ['commit', 'tree']),
    runtime: select(observation.runtime, ['node', 'npm', 'nodeExecutable', 'npmCli']),
    host: { ...select(observation.host, ['platform', 'arch', 'runnerOS', 'runnerArch', 'environment', 'imageOS', 'imageVersion', 'runnerName']),
      hardware: select(observation.host?.hardware, ['model', 'cpus', 'memoryBytes', 'release']) } };
  await writeFile(path.join(output, 'preflight.json'), JSON.stringify(preflight, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  validateNativeTools(preflight.runtime, preflight.host);
  return preflight;
}
const inside = (parent, child) => { const rel = path.relative(parent, child); return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); };
export function measurementEnvironment(input = process.env) {
  const env = { ...input };
  for (const key of Object.keys(env)) if (/^ACC_|^GIT_|^NODE_(OPTIONS|PATH|TEST_CONTEXT)$/.test(key)) delete env[key];
  return { ...env, ...CHILD_ENV, PATH: `${path.dirname(process.execPath)}${path.delimiter}${env.PATH ?? ''}` };
}
export async function createMeasurementOutput(requested, checkouts) {
  const absolute = path.resolve(requested);
  const output = path.join(await realpath(path.dirname(absolute)), path.basename(absolute));
  const roots = await Promise.all(checkouts.map(repo => realpath(repo)));
  requireValid(roots.every(repo => !inside(repo, output) && !inside(output, repo)), 'external output');
  await mkdir(output); // Existing directories and symlinks must remain untouched.
  return output;
}
async function identity(repo, expected, env) {
  const git = args => run('git', ['--no-replace-objects', '-C', repo, ...args], { env, maxBuffer: 1024 * 1024 });
  const [commit, tree] = (await git(['rev-parse', 'HEAD', 'HEAD^{tree}'])).stdout.trim().split('\n');
  requireValid(commit === expected && await checkoutMatchesCommit(repo, expected), 'checkout bytes/dependencies');
  return { commit, tree };
}
export async function runMeasurementCommand(executable, args, { cwd, env, output, prefix, signal }) {
  requireValid(!signal?.aborted, 'capture interrupted');
  requireValid(process.platform !== 'win32' || !signal, 'Windows cancellation unsupported');
  const stdout = await open(path.join(output, `${prefix}.stdout.log`), 'wx');
  const stderr = await open(path.join(output, `${prefix}.stderr.log`), 'wx');
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(executable, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', stdout.fd, stderr.fd] });
      let stopping = Promise.resolve(null);
      const interrupt = () => {
        stopping = stopPushProcessTree(child.pid);
        stopping.then(error => reject(error ?? Error('macos-measurement interrupted')));
      };
      signal?.addEventListener('abort', interrupt, { once: true });
      child.once('error', error => { signal?.removeEventListener('abort', interrupt); reject(error); });
      child.once('close', async code => {
        signal?.removeEventListener('abort', interrupt);
        const error = await stopping;
        if (error || signal?.aborted) reject(error ?? Error('macos-measurement interrupted'));
        else resolve(code ?? 1);
      });
      if (signal?.aborted) interrupt();
    });
  } finally { await stdout.close(); await stderr.close(); }
}
async function collect() {
  const started = performance.now(); let output;
  const cancellation = new AbortController();
  const interrupt = () => cancellation.abort();
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  try {
    const controllerRepo = await realpath(path.resolve(import.meta.dirname, '..'));
    const env = measurementEnvironment();
    const workloadRepo = await realpath(process.env.ACC_MACOS_MEASUREMENT_REPO);
    requireValid(!inside(controllerRepo, workloadRepo) && !inside(workloadRepo, controllerRepo), 'separate checkouts');
    output = await createMeasurementOutput(process.env.ACC_MACOS_MEASUREMENT_OUTPUT, [controllerRepo, workloadRepo]);
    const controllerHead = (await run('git', ['-C', controllerRepo, 'rev-parse', 'HEAD'], { env })).stdout.trim();
    const context = admitMeasurementContext({ env: process.env, event: await json(process.env.GITHUB_EVENT_PATH),
      head: controllerHead, platform: process.platform, arch: process.arch });
    requireValid(PROFILES.includes(process.env.ACC_MACOS_MEASUREMENT_PROFILE)
      && process.env.ACC_MACOS_MEASUREMENT_WORKLOAD_SHA === WORKLOAD.commit, 'profile/workload');
    const controller = await identity(controllerRepo, context.sha, env);
    const workload = await identity(workloadRepo, WORKLOAD.commit, env);
    const npmCli = await realpath(path.join(path.dirname(process.execPath), 'npm'));
    const runtime = { node: process.version, nodeExecutable: process.execPath, npmCli,
      npm: (await run(process.execPath, [npmCli, '--version'], { cwd: workloadRepo, env })).stdout.trim() };
    const host = { platform: process.platform, arch: process.arch, runnerOS: process.env.RUNNER_OS,
      runnerArch: process.env.RUNNER_ARCH, environment: process.env.RUNNER_ENVIRONMENT, imageOS: process.env.ImageOS,
      imageVersion: process.env.ImageVersion, runnerName: process.env.RUNNER_NAME,
      hardware: { model: os.cpus()[0]?.model, cpus: os.cpus().length, memoryBytes: os.totalmem(), release: os.release() } };
    const profile = process.env.ACC_MACOS_MEASUREMENT_PROFILE;
    await retainAndValidatePreflight(output, { profile, context, controller, workload, runtime, host });
    const record = { schema: 1, kind: 'acc-macos-partition-experiment', status: 'running', profile,
      context, controller, workload, runtime, host };
    await writeJson(path.join(output, 'capture.json'), record);
    const setupStart = performance.now();
    const capture = (executable, args, prefix, childEnv = env) => runMeasurementCommand(executable, args,
      { cwd: workloadRepo, env: childEnv, output, prefix, signal: cancellation.signal });
    requireValid(await capture(process.execPath, [npmCli, 'ci'], 'npm-ci') === 0, 'npm ci failed');
    const setupMs = performance.now() - setupStart;
    await identity(workloadRepo, WORKLOAD.commit, env);
    requireValid(await capture(process.execPath, ['scripts/run-tests.mjs', '--list'], 'discovery') === 0, 'discovery failed');
    const discovery = (await readFile(path.join(output, 'discovery.stdout.log'), 'utf8')).trim().split(/\r?\n/).slice(1)
      .map(file => path.relative(workloadRepo, file).split(path.sep).join('/'));
    validateDiscovery(discovery);
    const command = { executable: process.execPath, args: argsFor(profile), environment: CHILD_ENV };
    const runnerStart = performance.now();
    command.exitCode = await capture(command.executable, command.args, 'runner',
      { ...env, ACC_TEST_TIMINGS: path.join(output, 'acc-test-timings.jsonl') });
    const runnerMs = performance.now() - runnerStart;
    const after = { controller: await identity(controllerRepo, context.sha, env), workload: await identity(workloadRepo, WORKLOAD.commit, env) };
    requireValid(command.exitCode === 0, 'runner failed; diagnostics retained');
    const manifest = await json(path.join(output, 'acc-test-timings.jsonl.manifest.json'));
    const rawTimings = (await readFile(path.join(output, 'acc-test-timings.jsonl'), 'utf8')).trim().split(/\r?\n/)
      .map(line => { const item = JSON.parse(line); return { ...item, file: path.relative(workloadRepo, item.file).split(path.sep).join('/') }; });
    Object.assign(record, { status: 'passed', after, discovery, manifest, rawTimings, command,
      walls: { setupMs, runnerMs, wrapperMs: performance.now() - started } });
    validateMeasurement(record);
    requireValid(!cancellation.signal.aborted, 'capture interrupted');
    // Terminal handoff is synchronous: an interruption cannot race an awaited publication.
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    writeFileSync(path.join(output, 'measurement.json'), JSON.stringify(record, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    console.log(`experimental macOS measurement retained: ${profile}; no ordinary CI proof emitted`);
  } catch (error) {
    if (output) await writeJson(path.join(output, 'failure.json'), { schema: 1, kind: 'acc-macos-partition-failure',
      status: 'failed', runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      profile: process.env.ACC_MACOS_MEASUREMENT_PROFILE, message: String(error.message), wrapperMs: performance.now() - started }).catch(() => {});
    throw error;
  } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  collect().catch(error => { console.error(`macos-measurement failed: ${error.message}`); process.exitCode = 1; });
}
