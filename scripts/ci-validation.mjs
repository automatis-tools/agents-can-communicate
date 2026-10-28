#!/usr/bin/env node
// A deliberately small boundary: reauthenticate policy, execute, then publish.
import { appendFileSync, rmSync } from 'node:fs';
import { appendFile, lstat, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createCiRoute, verifyCiRoute, verifyCiInputs, ciWorker } from './ci-plan.mjs';
import { verifyCiAggregate, verifyCiTestManifest } from './ci-results.mjs';
import { runPushCommand } from './push-targets.mjs';

const fail = () => { throw Error('ci-validation-failed'); };
const inside = (root, file) => { const r = path.relative(root, file); return r === '' || (!r.startsWith(`..${path.sep}`) && r !== '..' && !path.isAbsolute(r)); };
async function context() {
  const repo = await realpath(process.cwd());
  const env = process.env;
  if (!env.CI || !env.RUNNER_TEMP || !path.isAbsolute(env.RUNNER_TEMP)
    || !env.GITHUB_OUTPUT || !path.isAbsolute(env.GITHUB_OUTPUT)
    || !env.GITHUB_EVENT_PATH || !path.isAbsolute(env.GITHUB_EVENT_PATH)) fail();
  const temporary = await realpath(env.RUNNER_TEMP);
  const output = await realpath(env.GITHUB_OUTPUT);
  const eventPath = await realpath(env.GITHUB_EVENT_PATH);
  const outputStat = await lstat(env.GITHUB_OUTPUT);
  if (inside(repo, temporary) || inside(temporary, repo) || inside(repo, output) || output === eventPath || !(await lstat(temporary)).isDirectory()
    || !outputStat.isFile() || outputStat.nlink !== 1 || !(await lstat(env.GITHUB_EVENT_PATH)).isFile()) fail();
  const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'));
  const paths = Object.fromEntries(['acc-test-timings.jsonl','acc-test-timings.jsonl.manifest.json',
    'acc-ci-plan.json','acc-ci-proof.json','acc-ci-selection.json'].map(name => [name, path.join(temporary,name)]));
  for (const file of Object.values(paths)) {
    const stat = await lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (stat && (!stat.isFile() || stat.nlink !== 1)) fail();
    if (file === output || path.resolve(env.GITHUB_EVENT_PATH) === file) fail();
  }
  return { repo, env, event, paths, output };
}
const parseRoute = env => JSON.parse(env.CI_ROUTE);
async function main() {
  const mode = process.argv[2];
  if (process.argv.length !== 3 || !['plan','test','aggregate','preflight'].includes(mode)) fail();
  const c = await context();
  const { repo, env, event, paths, output } = c;
  const { route, plan } = mode === 'plan' ? await createCiRoute({ repo, env, event })
    : await verifyCiRoute({ repo, env, event, route: parseRoute(env) });
  const publish = async (name, value) => appendFile(output, `${name}=${JSON.stringify(value)}\n`);
  if (mode === 'plan') {
    await writeFile(paths['acc-ci-plan.json'], JSON.stringify(plan), { mode: 0o600 });
    await verifyCiInputs(repo, route.targetCommit);
    await publish('route', route);
    await appendFile(output, `scope=${route.scope}\n`);
    return;
  }
  if (mode === 'aggregate') {
    verifyCiAggregate({ route, plan, platform: env.CI_PLATFORM, needs: JSON.parse(env.CI_NEEDS), runAttempt: env.GITHUB_RUN_ATTEMPT });
    return;
  }
  const role = ciWorker(env.CI_WORKER);
  if (!route.workers.includes(role.id) || role.platform !== process.platform) fail();
  if (mode === 'preflight') { if (role.kind === 'test') fail(); return; }
  if (role.kind !== 'test' || role.scope !== route.scope || env.NODE_TEST_CONTEXT) fail();
  // Only these fixed diagnostics belong to this invocation. The full plan and
  // transient selection live outside the checkout and cannot dirty its oracle.
  for (const name of Object.keys(paths)) await rm(paths[name], { force: true });
  await writeFile(paths['acc-ci-plan.json'], JSON.stringify(plan), { mode: 0o600 });
  const args = [path.join(repo,'scripts/run-tests.mjs')];
  if (role.shard) args.push('--shard', role.shard);
  if (role.scope === 'docs') {
    await writeFile(paths['acc-ci-selection.json'], JSON.stringify(plan), { mode: 0o600 });
    args.push('--selection-plan', paths['acc-ci-selection.json']);
  }
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  let published = false;
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  try {
    await runPushCommand(process.execPath, args, { cwd: repo, signal: controller.signal,
      env: { ACC_TEST_TIMINGS: paths['acc-test-timings.jsonl'], ACC_GATE_DIAGNOSTIC: paths['acc-test-timings.jsonl.manifest.json'] } });
    if (controller.signal.aborted) fail();
    const manifest = JSON.parse(await readFile(paths['acc-test-timings.jsonl.manifest.json'],'utf8'));
    if (controller.signal.aborted) fail();
    const proof = verifyCiTestManifest({ manifest, route, plan, worker: role.id, nodeVersion: process.version, runAttempt: env.GITHUB_RUN_ATTEMPT });
    await verifyCiInputs(repo, route.targetCommit);
    if (controller.signal.aborted) fail();
    await writeFile(paths['acc-ci-proof.json'], JSON.stringify(proof), { mode: 0o600 });
    if (controller.signal.aborted) fail();
    // Terminal handoff: no await separates the last cancellation check, owned
    // selection cleanup and successful job publication. Later signals do not
    // retroactively revoke this completed handoff; success has no async cleanup.
    rmSync(paths['acc-ci-selection.json'], { force: true });
    appendFileSync(output, `proof=${JSON.stringify(proof)}\n`);
    published = true;
  } finally {
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    if (!published && !controller.signal.aborted) await rm(paths['acc-ci-selection.json'], { force: true });
  }
}
try { await main(); }
catch { console.error('ci-validation-failed'); process.exitCode = 1; }
