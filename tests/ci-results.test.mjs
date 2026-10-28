import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { verifyCiTestManifest, verifyCiAggregate } from '../scripts/ci-results.mjs';
import { ciRouteDigest } from '../scripts/ci-plan.mjs';

const digest = files => createHash('sha256').update(JSON.stringify(files)).digest('hex');
const all = ['tests/a.test.mjs', 'tests/b.test.mjs', 'tests/c.test.mjs', 'tests/d.test.mjs'];
function facts(scope = 'docs') {
  const plan = { scope, selectedFiles: all, targetCommit: 'a'.repeat(40), targetTree: 'b'.repeat(40),
    planDigest: 'c'.repeat(64), selectionDigest: digest(all), discoveryDigest: digest(all) };
  const route = { schema: 1, scope, targetCommit: plan.targetCommit, targetTree: plan.targetTree,
    planDigest: plan.planDigest, selectionDigest: plan.selectionDigest, discoveryDigest: plan.discoveryDigest,
    runId: '1234', runAttempt: '1' };
  return { route, plan };
}
function sample(scope = 'docs', platform = 'linux', shard = null) {
  const { route, plan } = facts(scope);
  const worker = `${scope}-${platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : 'linux'}${shard ? `-${shard[0]}` : ''}`;
  const files = shard === '1/2' ? [all[0], all[2]] : shard === '2/2' ? [all[1], all[3]] : all;
  const identity = { schema: 1, commit: route.targetCommit, tree: route.targetTree, scope, platform,
    node: 'v24.4.0', concurrency: platform === 'win32' ? 3 : 4, fsyncMode: 'real',
    ...(scope === 'docs' ? { planDigest: plan.planDigest, selectionDigest: plan.selectionDigest } : {}),
    ...(shard ? { shard } : {}), fileCount: files.length, durationMs: 1 };
  const events = ['fingerprint', 'cache-lookup', 'packed-template', 'batch-execution',
    ...(scope === 'docs' ? ['package-smoke'] : []), 'cleanup', 'total'].map(event => ({ ...identity,
    event, result: ['fingerprint', 'cache-lookup'].includes(event) ? 'ci-disabled' : 'passed' }));
  const manifest = { schema: 1, events, files: files.map(file => ({ file, durationMs: 1, success: true })),
    receiptDecision: { reused: false, reason: 'ci-disabled' },
    resultCounts: { selected: files.length, completed: files.length, passed: files.length, failed: 0 } };
  const proof = { schema: 1, workerId: worker, routeDigest: ciRouteDigest(route), runId: '1234', runAttempt: '1',
    targetCommit: route.targetCommit, targetTree: route.targetTree, planDigest: plan.planDigest, scope,
    platform, node: 'v24.4.0', shard, fileCount: files.length, filesDigest: digest(files),
    concurrency: identity.concurrency, fsyncMode: 'real', packageSmoke: scope === 'docs' };
  return { route, plan, worker, runAttempt: '1', nodeVersion: 'v24.4.0', manifest, proof };
}
const clone = value => structuredClone(value);
for (const [scope, platform, shard] of [['docs','linux',null], ['docs','darwin',null], ['docs','win32',null],
  ['full','linux',null], ['full','darwin',null], ['full','win32','1/2'], ['full','win32','2/2']]) {
  test(`exact actual files produce ${scope} ${platform} ${shard ?? ''} proof`, () => {
    const s = sample(scope, platform, shard);
    assert.deepEqual(verifyCiTestManifest(s), s.proof);
  });
}
const corruptions = {
  empty: m => { m.files = []; }, duplicate: m => { m.files[1] = m.files[0]; },
  omitted: m => { m.files.pop(); }, foreign: m => { m.files[0].file = 'tests/foreign.test.mjs'; },
  failed: m => { m.files[0].success = false; }, counts: m => { m.resultCounts.passed--; },
  total: m => { m.events = m.events.filter(e => e.event !== 'total'); },
  duplicateTotal: m => { m.events.push(m.events.at(-1)); },
  cleanup: m => { m.events.find(e => e.event === 'cleanup').result = 'failed'; },
  pack: m => { m.events = m.events.filter(e => e.event !== 'packed-template'); },
  smoke: m => { m.events = m.events.filter(e => e.event !== 'package-smoke'); },
  batch: m => { m.events.find(e => e.event === 'batch-execution').fileCount--; },
  noBatches: m => { m.events = m.events.filter(e => e.event !== 'batch-execution'); },
  reused: m => { m.receiptDecision.reused = true; },
  persistence: m => { m.events.push({ ...m.events[0], event: 'receipt-persistence', result: 'saved' }); },
  inputDigest: m => { m.inputDigest = 'd'.repeat(64); },
  commit: m => { m.events[0].commit = 'd'.repeat(40); },
  tree: m => { m.events[0].tree = 'd'.repeat(40); },
  node: m => { m.events[0].node = 'v22.1.0'; },
  platform: m => { m.events[0].platform = 'win32'; },
  concurrency: m => { m.events[0].concurrency = 1; },
  fsync: m => { m.events[0].fsyncMode = 'skipped'; },
  fallback: m => { m.events.forEach(e => { e.scope = 'full'; }); },
  plan: m => { m.events[0].planDigest = 'd'.repeat(64); },
  selection: m => { delete m.events[0].selectionDigest; },
  shard: m => { m.events[0].shard = '1/2'; },
};
for (const [name, corrupt] of Object.entries(corruptions)) test(`rejects manifest ${name}`, () => {
  const s = sample(); corrupt(s.manifest); assert.throws(() => verifyCiTestManifest(s));
});
test('full run cannot carry a docs plan or smoke identity', () => {
  for (const key of ['planDigest','selectionDigest']) {
    const s = sample('full'); s.manifest.events[0][key] = 'a'.repeat(64);
    assert.throws(() => verifyCiTestManifest(s));
  }
});
function aggregate(scope, platform) {
  const s = sample(scope, platform, platform === 'win32' && scope === 'full' ? '1/2' : null);
  const names = platform === 'win32' ? ['docs-windows', 'full-windows-1', 'full-windows-2']
    : platform === 'darwin' ? ['docs-macos','full-macos'] : ['docs-linux','full-linux'];
  const needs = { plan: { result: 'success', outputs: { route: JSON.stringify(s.route) } } };
  for (const name of names) {
    const active = name.startsWith(scope);
    const part = name.endsWith('-1') ? '1/2' : name.endsWith('-2') ? '2/2' : null;
    needs[name] = { result: active ? 'success' : 'skipped', outputs: active ? {
      proof: JSON.stringify(sample(scope, platform, part).proof) } : {} };
  }
  return { route: s.route, plan: s.plan, platform, needs, runAttempt: '1' };
}
for (const scope of ['docs','full']) for (const platform of ['linux','darwin','win32']) {
  test(`aggregate accepts exact ${scope} ${platform} membership`, () => verifyCiAggregate(aggregate(scope, platform)));
}
for (const state of ['failure','cancelled','skipped','pending',null]) test(`aggregate rejects planned ${state}`, () => {
  const a = aggregate('docs','linux'); a.needs['docs-linux'].result = state;
  assert.throws(() => verifyCiAggregate(a));
});
for (const name of ['missing','extra','planner','planner-route','excluded-success','excluded-proof','no-proof']) {
  test(`aggregate rejects ${name}`, () => {
    const a = aggregate('full','win32');
    if (name === 'missing') delete a.needs['full-windows-2'];
    if (name === 'extra') a.needs.foreign = { result: 'skipped', outputs: {} };
    if (name === 'planner') a.needs.plan.result = 'failure';
    if (name === 'planner-route') a.needs.plan.outputs.route = '{}';
    if (name === 'excluded-success') a.needs['docs-windows'].result = 'success';
    if (name === 'excluded-proof') a.needs['docs-windows'].outputs.proof = '{}';
    if (name === 'no-proof') delete a.needs['full-windows-1'].outputs.proof;
    assert.throws(() => verifyCiAggregate(a));
  });
}
for (const [key, value] of Object.entries({ workerId: 'docs-macos', routeDigest: 'd'.repeat(64), runId: '2',
  runAttempt: '2', targetCommit: 'd'.repeat(40), targetTree: 'd'.repeat(40), planDigest: 'd'.repeat(64),
  scope: 'full', platform: 'darwin', node: 'v22.0.0', shard: '1/2', fileCount: 99,
  filesDigest: 'd'.repeat(64), concurrency: 3, fsyncMode: 'skipped', packageSmoke: false, extra: true })) {
  test(`aggregate rejects foreign proof ${key}`, () => {
    const a = aggregate('docs','linux'); const p = clone(sample().proof); p[key] = value;
    a.needs['docs-linux'].outputs.proof = JSON.stringify(p); assert.throws(() => verifyCiAggregate(a));
  });
}

function proofAttempt(a, worker, attempt) {
  const proof = JSON.parse(a.needs[worker].outputs.proof);
  a.needs[worker].outputs.proof = JSON.stringify({ ...proof, runAttempt: attempt, routeDigest: ciRouteDigest(a.route) });
}
test('manifest proof records actual worker attempt without changing planner lineage', () => {
  const s = sample();
  assert.deepEqual(verifyCiTestManifest({ ...s, runAttempt: '2' }), { ...s.proof, runAttempt: '2' });
  for (const runAttempt of ['0', '01', '-1', '1.5', '1\n', 1, null, undefined]) {
    assert.throws(() => verifyCiTestManifest({ ...s, runAttempt }));
  }
  s.route.runAttempt = '2';
  assert.throws(() => verifyCiTestManifest({ ...s, runAttempt: '1' }));
});
test('aggregate accepts retained successes and mixed Windows attempts without relabeling', () => {
  const a = aggregate('full', 'win32');
  a.runAttempt = '3';
  proofAttempt(a, 'full-windows-2', '2');
  const before = clone(a);
  verifyCiAggregate(a);
  assert.deepEqual(a, before);
});
test('aggregate bounds proof and current attempts exactly, including beyond Number precision', () => {
  const a = aggregate('full', 'win32');
  a.route.runAttempt = '9007199254740993';
  a.runAttempt = '9007199254740994';
  a.needs.plan.outputs.route = JSON.stringify(a.route);
  proofAttempt(a, 'full-windows-1', '9007199254740993');
  proofAttempt(a, 'full-windows-2', '9007199254740994');
  verifyCiAggregate(a);
  for (const attempt of ['9007199254740992', '9007199254740995', '0', '01', '-1', '1.5', '1\n', 1, null, undefined]) {
    const broken = clone(a); proofAttempt(broken, 'full-windows-1', attempt);
    assert.throws(() => verifyCiAggregate(broken), `invalid proof attempt ${attempt}`);
  }
  const future = aggregate('docs', 'linux');
  future.runAttempt = '9007199254740992';
  proofAttempt(future, 'docs-linux', '9007199254740993');
  assert.throws(() => verifyCiAggregate(future), 'adjacent future attempt must not round down');
  for (const runAttempt of ['9007199254740992', '9007199254740993', '0', '01', '1\n', 1, null, undefined]) {
    assert.throws(() => verifyCiAggregate({ ...a, runAttempt }), `invalid aggregate attempt ${runAttempt}`);
  }
});
