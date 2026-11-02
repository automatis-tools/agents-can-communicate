#!/usr/bin/env node
// Optional CI diagnostic: a closed, non-secret runner profile beside the timing
// artifacts. Consumers use it to separate code cost from host differences. It never
// reads or changes proof, receipt, selection, concurrency or durability inputs.
import { execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const PROFILE_FILE = 'acc-runner-profile.json';
// Each accepted value is a short printable scalar. Path-like text is refused so
// that a home directory, workspace or tool location never enters the artifact.
const text = value => typeof value === 'string' && /^[\x20-\x7e]{1,200}$/.test(value.trim())
  && !/[\\/]/.test(value) ? value.trim() : null;
const name = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(value) ? value : null;
const number = value => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) ? value : null;
const count = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const oid = value => typeof value === 'string' && /^([a-f0-9]{40}|[a-f0-9]{64})$/.test(value) ? value : null;
const version = value => typeof value === 'string' && /^v?\d+\.\d+\.\d+$/.test(value) ? value : null;
// One closed field table drives both recording and reading, so a stored profile
// is accepted only with the values that recording itself could have produced.
const FIELDS = {
  run: { id: number, attempt: number, job: name, worker: name },
  source: { commit: oid, tree: oid },
  cohort: { platform: name, arch: name, release: text, runnerOS: name, runnerArch: name, runnerEnvironment: name,
    imageOS: name, imageVersion: name, cpuModel: text, cpus: count, memoryBytes: count, node: version, npm: version },
};
export const COHORT_FIELDS = Object.keys(FIELDS.cohort);
const unavailableIn = profile => Object.entries(FIELDS).flatMap(([group, fields]) =>
  Object.keys(fields).filter(key => profile[group][key] === null).map(key => `${group}.${key}`));

// Builds the profile from raw observations. Every field is named here; a value
// that is missing or fails its check becomes null and is listed as unavailable.
export function buildProfile(observed = {}) {
  const env = observed.env ?? {};
  const cpus = Array.isArray(observed.cpus) ? observed.cpus : [];
  const raw = {
    run: { id: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT, job: env.GITHUB_JOB, worker: env.CI_WORKER },
    source: { commit: observed.commit, tree: observed.tree },
    cohort: { platform: observed.platform, arch: observed.arch, release: observed.release, runnerOS: env.RUNNER_OS,
      runnerArch: env.RUNNER_ARCH, runnerEnvironment: env.RUNNER_ENVIRONMENT, imageOS: env.ImageOS,
      imageVersion: env.ImageVersion, cpuModel: cpus[0]?.model, cpus: cpus.length, memoryBytes: observed.memoryBytes,
      node: observed.node, npm: observed.npm },
  };
  const profile = { schema: 1, kind: 'acc-runner-profile', ...Object.fromEntries(Object.entries(FIELDS).map(
    ([group, fields]) => [group, Object.fromEntries(Object.entries(fields).map(([key, check]) => [key, check(raw[group][key])]))])) };
  profile.unavailable = unavailableIn(profile);
  return profile;
}

const exactKeys = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
// A profile is valid only with the closed shape, values that pass their field
// check unchanged, and an unavailable list that names exactly its null fields.
export function validProfile(profile) {
  return exactKeys(profile, ['schema', 'kind', ...Object.keys(FIELDS), 'unavailable'])
    && profile.schema === 1 && profile.kind === 'acc-runner-profile'
    && Object.entries(FIELDS).every(([group, fields]) => exactKeys(profile[group], Object.keys(fields))
      && Object.entries(fields).every(([key, check]) => profile[group][key] === null || check(profile[group][key]) === profile[group][key]))
    && Array.isArray(profile.unavailable) && JSON.stringify(profile.unavailable) === JSON.stringify(unavailableIn(profile));
}

// Two timings are comparable only when every cohort fact is known and equal.
// The result names each difference; it never normalizes one host to another.
export function compareProfiles(a, b) {
  if (!validProfile(a) || !validProfile(b)) return { comparable: false, differences: ['invalid-profile'] };
  const differences = COHORT_FIELDS.flatMap(field => a.cohort[field] === null || b.cohort[field] === null
    ? [`unavailable:${field}`] : a.cohort[field] !== b.cohort[field] ? [`different:${field}`] : []);
  return { comparable: differences.length === 0, differences };
}

async function npmVersion(executable) {
  const bin = path.dirname(executable);
  for (const file of [path.join(bin, 'node_modules/npm/package.json'),
    path.join(path.dirname(bin), 'lib/node_modules/npm/package.json')]) {
    try { return JSON.parse(await readFile(file, 'utf8')).version; } catch { /* Try the other layout. */ }
  }
  return null;
}
async function checkout(cwd, env) {
  const gitEnv = { ...env };
  delete gitEnv.GIT_DIR; delete gitEnv.GIT_WORK_TREE;
  try {
    const { stdout } = await run('git', ['rev-parse', 'HEAD', 'HEAD^{tree}'], { cwd, env: gitEnv, timeout: 10_000 });
    const [commit, tree] = stdout.trim().split(/\r?\n/);
    return { commit, tree };
  } catch { return {}; }
}
export async function observeRunner({ cwd = process.cwd(), env = process.env } = {}) {
  return { env, cpus: os.cpus(), memoryBytes: os.totalmem(), release: os.release(), platform: process.platform,
    arch: process.arch, node: process.version, npm: await npmVersion(process.execPath), ...await checkout(cwd, env) };
}

// Replaces any existing entry instead of writing through it.
export async function recordProfile(output, profile) {
  await rm(output, { force: true });
  await writeFile(output, JSON.stringify(profile, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}

async function cli(args) {
  const [command, ...rest] = args;
  if (command === 'record' && rest.length === 0) {
    const temp = process.env.RUNNER_TEMP;
    if (!temp || !path.isAbsolute(temp)) throw Error('runner-profile: an absolute RUNNER_TEMP is required');
    const output = path.join(temp, PROFILE_FILE);
    const profile = buildProfile(await observeRunner());
    await recordProfile(output, profile);
    const { cpuModel, cpus, memoryBytes, imageOS, imageVersion } = profile.cohort;
    const memory = memoryBytes === null ? 'unknown' : `${(memoryBytes / 2 ** 30).toFixed(1)} GiB`;
    console.log(`runner profile: ${cpuModel ?? 'unknown CPU'} x${cpus ?? '?'}, ${memory}, `
      + `${imageOS ?? 'unknown image'} ${imageVersion ?? ''}`.trimEnd()
      + `; unavailable: ${profile.unavailable.length ? profile.unavailable.join(', ') : 'none'}`);
    return 0;
  }
  if (command === 'compare' && rest.length === 2) {
    const [a, b] = await Promise.all(rest.map(async file => JSON.parse(await readFile(file, 'utf8'))));
    const result = compareProfiles(a, b);
    console.log(JSON.stringify(result));
    return result.comparable ? 0 : 2;
  }
  throw Error('usage: runner-profile.mjs record | compare <a.json> <b.json>');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  cli(process.argv.slice(2)).then(code => { process.exitCode = code; },
    error => { console.error(error.message); process.exitCode = 1; });
}
