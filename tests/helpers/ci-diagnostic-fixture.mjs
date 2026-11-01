// Synthetic child diagnostics exercise the real CI driver, not runner/package execution.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ciRunnerFixture } from './ci-runner-fixture.mjs';

// Independent fixture membership: never derive the oracle from a returned plan.
const selected = Object.freeze([
  'tests/acceptance/package-links.test.mjs',
  'tests/acceptance/packaging.test.mjs',
  'tests/acceptance/recorded-candidate.test.mjs',
  'tests/docs/probe.test.mjs',
  'tests/package-certification.test.mjs',
  'tests/process/orchestration-is-absent.test.mjs',
  'tests/process/session-resolution.test.mjs',
  'tests/process/surface-coverage.test.mjs',
]);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

const runner = `import {appendFile,readFile,writeFile} from 'node:fs/promises';
const input=JSON.parse(await readFile(process.env.CI_FIXTURE_DIAGNOSTIC_INPUT,'utf8'));
const diagnosticPath=process.env.ACC_GATE_DIAGNOSTIC;
if(input.action==='write') await writeFile(diagnosticPath,input.bytes);
else if(input.action!=='missing') throw Error('unknown synthetic diagnostic action');
await appendFile(process.env.CI_FIXTURE_DIAGNOSTIC_COMPLETIONS,JSON.stringify({
  kind:'synthetic-ci-diagnostic',invocationId:input.invocationId,diagnosticPath,
  argv:process.argv,pid:process.pid,action:input.action,intendedExit:0})+'\\n');
`;

export async function ciDiagnosticFixture(t) {
  const f = await ciRunnerFixture(t, { runnerOnly: runner });
  const inputPath = path.join(f.base, 'ci-synthetic-input.json');
  const completionPath = path.join(f.base, 'ci-synthetic-completions.jsonl');
  const baselinePath = path.join(f.base, 'ci-synthetic-baseline.json');
  // These private child inputs are outside both checked source and driver cleanup.
  f.env.CI_FIXTURE_DIAGNOSTIC_INPUT = inputPath;
  f.env.CI_FIXTURE_DIAGNOSTIC_COMPLETIONS = completionPath;
  const planned = await f.invoke('plan');
  assert.equal(planned.code, 0, planned.stderr);
  const route = JSON.parse(planned.outputs.route);
  const plan = JSON.parse(await readFile(path.join(f.temporary, 'acc-ci-plan.json'), 'utf8'));
  const worker = { linux: 'docs-linux', darwin: 'docs-macos', win32: 'docs-windows' }[process.platform];
  const concurrency = process.platform === 'win32' ? 3 : 4;
  assert.equal(f.worker, worker);
  assert.equal(route.scope, 'docs');
  assert.equal(plan.scope, 'docs');
  assert.equal(route.runId, '1234');
  assert.equal(route.runAttempt, '1');
  assert.equal(route.eventName, 'pull_request');
  assert.equal(route.ref, 'refs/pull/17/merge');
  assert.equal(route.baseCommit, f.baseCommit);
  assert.equal(route.headCommit, f.event.pull_request.head.sha);
  assert.equal(route.targetCommit, f.targetCommit);
  assert.match(process.version, /^v24\.\d+\.\d+$/);
  assert.deepEqual(plan.selectedFiles, selected);
  assert.equal(plan.selectedFiles.includes('tests/runtime.test.mjs'), false);
  assert.equal(plan.selectionDigest, digest(selected));
  assert.equal(plan.discoveryDigest, digest([...selected, 'tests/runtime.test.mjs'].sort()));
  for (const key of ['targetCommit', 'targetTree', 'planDigest', 'selectionDigest', 'discoveryDigest']) {
    assert.equal(route[key], plan[key]);
  }
  const identity = { schema: 1, commit: f.targetCommit, tree: plan.targetTree, scope: 'docs',
    platform: process.platform, node: process.version, concurrency, fsyncMode: 'real',
    planDigest: plan.planDigest, selectionDigest: digest(selected), fileCount: 8, durationMs: 1 };
  const baselineManifest = { schema: 1,
    events: ['fingerprint', 'cache-lookup', 'packed-template', 'batch-execution', 'package-smoke', 'cleanup', 'total']
      .map(event => ({ ...identity, event, result: ['fingerprint', 'cache-lookup'].includes(event) ? 'ci-disabled' : 'passed' })),
    files: selected.map(file => ({ file, durationMs: 1, success: true })),
    receiptDecision: { reused: false, reason: 'ci-disabled' },
    resultCounts: { selected: 8, completed: 8, passed: 8, failed: 0 } };
  const expectedProof = { schema: 1, workerId: worker, routeDigest: digest(canonical(route)),
    runId: '1234', runAttempt: '1', targetCommit: f.targetCommit, targetTree: plan.targetTree,
    planDigest: plan.planDigest, scope: 'docs', platform: process.platform, node: process.version,
    shard: null, fileCount: 8, filesDigest: digest(selected), concurrency, fsyncMode: 'real', packageSmoke: true };
  await writeFile(baselinePath, JSON.stringify(baselineManifest));
  const checkedRoot = await realpath(f.root);
  const runnerTemp = await realpath(f.temporary);
  const diagnosticPath = path.join(runnerTemp, 'acc-test-timings.jsonl.manifest.json');
  const proofPath = path.join(runnerTemp, 'acc-ci-proof.json');
  const expectedArgv = [process.execPath, path.join(checkedRoot, 'scripts/run-tests.mjs'),
    '--selection-plan', path.join(runnerTemp, 'acc-ci-selection.json')];
  const completions = async () => {
    const bytes = await readFile(completionPath, 'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return '';
    });
    return bytes.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  };
  let invocation = 0;
  return { ...f, route, plan, baselineManifest, expectedProof, baselinePath, diagnosticPath, proofPath, expectedArgv,
    runDiagnostic: async ({ action = 'write', bytes }) => {
      const invocationId = String(++invocation);
      const completionsBefore = await completions();
      await writeFile(inputPath, JSON.stringify({ invocationId, action, bytes }));
      const result = await f.invoke('test', { CI_ROUTE: planned.outputs.route, CI_WORKER: f.worker });
      return { result, invocationId, completionsBefore, completionsAfter: await completions() };
    } };
}
