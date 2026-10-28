// CI completion is evidence about actual execution, never a scheduling promise.
import { createHash } from 'node:crypto';
import { ciRouteDigest, ciWorker, platformTestWorkers } from './ci-plan.mjs';
import { shardFiles } from './test-shards.mjs';

const fail = () => { throw Error('ci-execution-proof-invalid'); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => object(value) && same(Object.keys(value).sort(), [...expected].sort());
const hash = files => createHash('sha256').update(JSON.stringify(files)).digest('hex');
const nonnegative = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const positive = value => typeof value === 'string' && /^[1-9][0-9]*$/.test(value);
const node24 = version => typeof version === 'string' && /^v24\.\d+\.\d+$/.test(version);
const relative = file => typeof file === 'string' && /^(tests|packages)\/.+\.test\.mjs$/.test(file)
  && !file.includes('\\') && !file.includes(':') && file.split('/').every(p => p && p !== '.' && p !== '..');
function expectedProof({ route, plan, worker, nodeVersion, runAttempt }) {
  const role = ciWorker(typeof worker === 'string' ? worker : worker?.id);
  if (!positive(route?.runAttempt) || !positive(runAttempt) || BigInt(runAttempt) < BigInt(route.runAttempt)
    || role.kind !== 'test' || role.scope !== route?.scope || plan?.scope !== route.scope || !node24(nodeVersion)
    || !['targetCommit','targetTree','planDigest','selectionDigest','discoveryDigest'].every(k => route[k] === plan[k])
    || !Array.isArray(plan.selectedFiles) || !plan.selectedFiles.length || !plan.selectedFiles.every(relative)
    || !same(plan.selectedFiles, [...new Set(plan.selectedFiles)].sort())) fail();
  const shard = role.shard ? { part: Number(role.shard[0]), count: 2 } : null;
  const files = shardFiles(plan.selectedFiles, shard);
  const proof = { schema: 1, workerId: role.id, routeDigest: ciRouteDigest(route), runId: route.runId,
    runAttempt, targetCommit: route.targetCommit, targetTree: route.targetTree,
    planDigest: route.planDigest, scope: role.scope, platform: role.platform, node: nodeVersion,
    shard: role.shard, fileCount: files.length, filesDigest: hash(files),
    concurrency: role.platform === 'win32' ? 3 : 4, fsyncMode: 'real', packageSmoke: role.scope === 'docs' };
  return { role, files, proof };
}
export function verifyCiTestManifest({ manifest, route, plan, worker, nodeVersion, runAttempt }) {
  const { files, proof } = expectedProof({ route, plan, worker, nodeVersion, runAttempt });
  if (!keys(manifest, ['schema','events','files','receiptDecision','resultCounts']) || manifest.schema !== 1
    || !keys(manifest.receiptDecision, ['reused','reason']) || manifest.receiptDecision.reused !== false
    || manifest.receiptDecision.reason !== 'ci-disabled' || !Array.isArray(manifest.files)
    || manifest.files.length !== files.length) fail();
  const actual = [];
  for (const record of manifest.files) {
    if (!keys(record, ['file','durationMs','success']) || !relative(record.file)
      || !nonnegative(record.durationMs) || record.success !== true) fail();
    actual.push(record.file);
  }
  if (!same(actual.sort(), files) || !keys(manifest.resultCounts, ['selected','completed','passed','failed'])
    || !Object.entries({ selected: files.length, completed: files.length, passed: files.length, failed: 0 })
      .every(([key,value]) => manifest.resultCounts[key] === value)) fail();
  if (!Array.isArray(manifest.events) || !manifest.events.length) fail();
  const phases = new Map();
  let batchCount = 0;
  for (const event of manifest.events) {
    const identity = { schema: 1, commit: route.targetCommit, tree: route.targetTree, scope: proof.scope,
      platform: proof.platform, node: nodeVersion, concurrency: proof.concurrency, fsyncMode: 'real',
      ...(proof.scope === 'docs' ? { planDigest: plan.planDigest, selectionDigest: plan.selectionDigest } : {}),
      ...(proof.shard ? { shard: proof.shard } : {}) };
    if (!keys(event, [...Object.keys(identity), 'fileCount','event','durationMs','result'])
      || !Object.entries(identity).every(([k,v]) => event[k] === v) || !nonnegative(event.durationMs)
      || !Number.isSafeInteger(event.fileCount) || event.fileCount < 1) fail();
    const expectedResult = ['fingerprint','cache-lookup'].includes(event.event) ? 'ci-disabled' : 'passed';
    if (event.result !== expectedResult) fail();
    phases.set(event.event, (phases.get(event.event) ?? 0) + 1);
    if (event.event === 'batch-execution') batchCount += event.fileCount;
    else if (event.fileCount !== files.length) fail();
  }
  const single = ['fingerprint','cache-lookup','packed-template','cleanup','total', ...(proof.packageSmoke ? ['package-smoke'] : [])];
  if (!single.every(name => phases.get(name) === 1) || !phases.get('batch-execution') || batchCount !== files.length
    || [...phases.keys()].some(name => !single.includes(name) && name !== 'batch-execution')
    || manifest.events.at(-1).event !== 'total') fail();
  return proof;
}
export function verifyCiAggregate({ route, plan, platform, needs, runAttempt }) {
  const workers = platformTestWorkers(platform);
  if (!positive(route?.runAttempt) || !positive(runAttempt) || BigInt(runAttempt) < BigInt(route.runAttempt)
    || !keys(needs, ['plan', ...workers]) || needs.plan?.result !== 'success') fail();
  let actualRoute;
  try { actualRoute = JSON.parse(needs.plan.outputs.route); } catch { fail(); }
  if (ciRouteDigest(actualRoute) !== ciRouteDigest(route)) fail();
  for (const worker of workers) {
    const job = needs[worker];
    const planned = ciWorker(worker).scope === route.scope;
    if (!planned) {
      if (job?.result !== 'skipped' || job.outputs?.proof) fail();
      continue;
    }
    if (job?.result !== 'success') fail();
    let proof;
    try { proof = JSON.parse(job.outputs.proof); } catch { fail(); }
    // Only current successful needs may carry an older execution. Never relabel
    // it; the proof still names its worker attempt and particular planner digest.
    if (!positive(proof?.runAttempt) || BigInt(proof.runAttempt) > BigInt(runAttempt)) fail();
    const expected = expectedProof({ route, plan, worker, nodeVersion: proof.node, runAttempt: proof.runAttempt }).proof;
    if (!keys(proof, Object.keys(expected)) || !Object.entries(expected).every(([k,v]) => proof[k] === v)) fail();
  }
}
