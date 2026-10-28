import assert from 'node:assert/strict';
import test from 'node:test';
import { ciRunnerFixture, postRunInterruption } from '../helpers/ci-runner-fixture.mjs';

test('production CLI executes docs, exact smoke, then proof', async t => {
  const f = await ciRunnerFixture(t);
  const plan = await f.invoke('plan'); assert.equal(plan.code, 0, plan.stderr);
  const result = await f.invoke('test', { CI_ROUTE: plan.outputs.route, CI_WORKER: f.worker });
  assert.equal(result.code, 0, result.stderr);
  assert.equal((await readdir(f.temporary)).includes('acc-ci-selection.json'),false);
  assert.equal((await f.records('docs')).length, 1);
  assert.equal((await f.records('runtime')).length, 0);
  assert.equal((await f.records('smoke')).length, 1);
  assert.equal(JSON.parse(result.outputs.proof).scope, 'docs');
});

import { readFile, writeFile, readdir, link } from 'node:fs/promises';
import path from 'node:path';
import { ciRouteDigest } from '../../scripts/ci-plan.mjs';
const noProof = result => { assert.notEqual(result.code,0); assert.equal(result.outputs.proof,undefined); };
const sabotage = body => `\n{const fs=await import('node:fs/promises'); const p=process.env.ACC_GATE_DIAGNOSTIC;
  const m=JSON.parse(await fs.readFile(p,'utf8')); ${body} await fs.writeFile(p,JSON.stringify(m));}\n`;

test('full CLI executes unscoped discovery with no docs smoke or receipt reuse', async t => {
  const f = await ciRunnerFixture(t,{ scope: 'full' });
  const p = await f.invoke('plan'); assert.equal(p.code,0,p.stderr); assert.equal(p.outputs.scope,'full');
  for (let count=1;count<=2;count++) {
    const r = await f.invoke('test',{ CI_ROUTE:p.outputs.route,CI_WORKER:f.worker });
    assert.equal(r.code,0,r.stderr);
    assert.equal((await f.records('runtime')).length,count);
    assert.equal((await f.records('docs')).length,process.platform==='win32'?0:count);
    assert.equal((await f.records('smoke')).length,0);
    const m=JSON.parse(await readFile(path.join(f.temporary,'acc-test-timings.jsonl.manifest.json'),'utf8'));
    assert.deepEqual(m.receiptDecision,{reused:false,reason:'ci-disabled'});
    assert.equal(m.events.some(e=>e.event==='receipt-persistence'),false);
  }
});

test('CLI rejects unauthenticated context and wrong roles before any execution', async t => {
  const f=await ciRunnerFixture(t); const p=await f.invoke('plan'); assert.equal(p.code,0,p.stderr);
  const base={ CI_ROUTE:p.outputs.route,CI_WORKER:f.worker };
  for (const overrides of [{CI_ROUTE:'{}'}, {GITHUB_RUN_ID:'2'}, {GITHUB_RUN_ATTEMPT:'0'},
    {GITHUB_EVENT_NAME:'push'}, {GITHUB_REF:'refs/heads/main'}, {CI_WORKER:'full-linux'},
    {CI_WORKER:'package-macos-latest'}, {CI_WORKER:'unknown'}, {NODE_TEST_CONTEXT:'child-v8'},
    {RUNNER_TEMP:''}, {RUNNER_TEMP:f.root}, {GITHUB_OUTPUT:path.join(f.root,'README.md')}, {CI:''}]) {
    noProof(await f.invoke('test',{...base,...overrides}));
  }
  assert.equal((await f.records('docs')).length,0);
  assert.equal((await f.records('packs')).length,0);
});

test('CLI reauthenticates event and checkout bytes before publishing any plan', async t => {
  const f=await ciRunnerFixture(t);
  await writeFile(f.eventPath,JSON.stringify({...f.event,number:99}));
  noProof(await f.invoke('plan'));
  await writeFile(f.eventPath,JSON.stringify(f.event));
  await f.write('README.md','dirty'); const r=await f.invoke('plan');
  assert.notEqual(r.code,0); assert.deepEqual(r.outputs,{});
});

test('auxiliary preflight accepts only a planned native auxiliary worker', async t => {
  const f=await ciRunnerFixture(t); const p=await f.invoke('plan');
  const suffix=process.platform==='darwin'?'macos-latest':process.platform==='win32'?'windows-latest':'ubuntu-latest';
  const env={CI_ROUTE:p.outputs.route,CI_WORKER:`package-${suffix}`};
  assert.equal((await f.invoke('preflight',env)).code,0);
  noProof(await f.invoke('preflight',{...env,CI_WORKER:f.worker}));
  await f.write('README.md','dirty'); noProof(await f.invoke('preflight',env));
});

for (const [name, suffix] of Object.entries({
  missing: `\nawait (await import('node:fs/promises')).unlink(process.env.ACC_GATE_DIAGNOSTIC);`,
  invalid: `\nawait (await import('node:fs/promises')).writeFile(process.env.ACC_GATE_DIAGNOSTIC,'{');`,
  zero: sabotage('m.files=[];'), duplicate: sabotage('m.files[1]=m.files[0];'),
  foreign: sabotage("m.files[0].file='tests/foreign.test.mjs';"), failed: sabotage('m.files[0].success=false;'),
  smoke: sabotage("m.events=m.events.filter(e=>e.event!=='package-smoke');"),
  fallback: sabotage("m.events.forEach(e=>e.scope='full');"),
  batch: sabotage("m.events.find(e=>e.event==='batch-execution').fileCount--;"),
  stale: sabotage("m.events.forEach(e=>e.commit='a'.repeat(40));"),
  child: '\nprocess.exitCode=1;',
})) test(`no proof for actual CLI ${name} diagnostics or child failure`,async t=>{
  const f=await ciRunnerFixture(t,{runnerSuffix:suffix}); const p=await f.invoke('plan');
  assert.equal(p.code,0,p.stderr);
  noProof(await f.invoke('test',{CI_ROUTE:p.outputs.route,CI_WORKER:f.worker}));
  assert.equal((await f.records('docs')).length,1);
});

test('zero-execution runner cannot reuse stale matching success diagnostics',async t=>{
  const f=await ciRunnerFixture(t,{ runnerOnly: 'process.exit(0);\n' });
  const p=await f.invoke('plan'); assert.equal(p.code,0,p.stderr); assert.equal(p.outputs.scope,'docs');
  const route=JSON.parse(p.outputs.route);
  const plan=JSON.parse(await readFile(path.join(f.temporary,'acc-ci-plan.json'),'utf8'));
  const identity={schema:1,commit:route.targetCommit,tree:route.targetTree,scope:'docs',platform:process.platform,
    node:process.version,concurrency:process.platform==='win32'?3:4,fsyncMode:'real',
    planDigest:plan.planDigest,selectionDigest:plan.selectionDigest,fileCount:plan.selectedFiles.length,durationMs:1};
  const stale={schema:1,events:['fingerprint','cache-lookup','packed-template','batch-execution','package-smoke','cleanup','total']
    .map(event=>({...identity,event,result:['fingerprint','cache-lookup'].includes(event)?'ci-disabled':'passed'})),
    files:plan.selectedFiles.map(file=>({file,durationMs:1,success:true})),receiptDecision:{reused:false,reason:'ci-disabled'},
    resultCounts:{selected:plan.selectedFiles.length,completed:plan.selectedFiles.length,passed:plan.selectedFiles.length,failed:0}};
  await writeFile(path.join(f.temporary,'acc-test-timings.jsonl.manifest.json'),JSON.stringify(stale));
  await writeFile(path.join(f.temporary,'acc-ci-proof.json'),'{"old":true}');
  noProof(await f.invoke('test',{CI_ROUTE:p.outputs.route,CI_WORKER:f.worker}));
  assert.equal((await readdir(f.temporary)).includes('acc-ci-proof.json'),false);
  assert.equal((await f.records('docs')).length,0);
});

test('changed checked bytes after successful execution cannot emit proof',async t=>{
  const f=await ciRunnerFixture(t,{runnerSuffix:"\nawait writeFile(new URL('../README.md',import.meta.url),'changed after execution');"});
  const p=await f.invoke('plan'); assert.equal(p.code,0,p.stderr);
  noProof(await f.invoke('test',{CI_ROUTE:p.outputs.route,CI_WORKER:f.worker}));
  assert.equal((await f.records('docs')).length,1);
});

test('production aggregate CLI requires exact proofs and fresh event identity',async t=>{
  const f=await ciRunnerFixture(t); const p=await f.invoke('plan');
  const r=await f.invoke('test',{CI_ROUTE:p.outputs.route,CI_WORKER:f.worker}); assert.equal(r.code,0,r.stderr);
  const platform=process.platform;
  const excluded=platform==='darwin'?['full-macos']:platform==='win32'?['full-windows-1','full-windows-2']:['full-linux'];
  const needs={plan:{result:'success',outputs:{route:p.outputs.route}},[f.worker]:{result:'success',outputs:{proof:r.outputs.proof}},
    ...Object.fromEntries(excluded.map(name=>[name,{result:'skipped',outputs:{}}]))};
  const env={CI_ROUTE:p.outputs.route,CI_PLATFORM:platform,CI_NEEDS:JSON.stringify(needs)};
  assert.equal((await f.invoke('aggregate',env)).code,0);
  const proof=JSON.parse(r.outputs.proof); proof.filesDigest='d'.repeat(64);
  needs[f.worker].outputs.proof=JSON.stringify(proof);
  noProof(await f.invoke('aggregate',{...env,CI_NEEDS:JSON.stringify(needs)}));
  assert.equal((await f.invoke('aggregate',{...env,GITHUB_RUN_ATTEMPT:'2'})).code,0);
  assert.equal(proof.routeDigest,ciRouteDigest(JSON.parse(p.outputs.route)));
});

test('CLI rejects output aliasing its event and unsafe ancestor temp contexts',async t=>{
  const f=await ciRunnerFixture(t);
  const p=await f.invoke('plan'); assert.equal(p.code,0,p.stderr);
  const alias=await f.invoke('plan',{GITHUB_OUTPUT:f.eventPath});
  assert.notEqual(alias.code,0);
  await writeFile(f.eventPath,JSON.stringify(f.event));
  const unsafe=await f.invoke('plan',{RUNNER_TEMP:path.parse(f.root).root});
  assert.notEqual(unsafe.code,0);
});

import { spawn } from 'node:child_process';
import { waitForOwnedProcessExit } from '../helpers/push-fixture.mjs';
test('interrupted real test execution never emits proof',{skip:process.platform==='win32'},async t=>{
  const f=await ciRunnerFixture(t,{testSuffix:`\nappendFileSync(process.env.CI_TEST_STARTED,JSON.stringify({pid:process.pid,parent:process.ppid}));
    await new Promise(resolve=>setTimeout(resolve,10000));`});
  const p=await f.invoke('plan'); assert.equal(p.code,0,p.stderr);
  const started=path.join(f.base,'started');
  await writeFile(f.outputPath,'');
  const child=spawn(process.execPath,[path.join(f.root,'scripts/ci-validation.mjs'),'test'],{cwd:f.root,
    env:{...f.env,CI_ROUTE:p.outputs.route,CI_WORKER:f.worker,CI_TEST_STARTED:started},stdio:'ignore'});
  const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
  let owned;
  try {
    const deadline=Date.now()+10000;
    while(Date.now()<deadline) {
      const bytes=await readFile(started,'utf8').catch(()=>null);
      if(bytes){owned=JSON.parse(bytes);break;}
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.ok(owned,'actual test must start before interruption');
    // Observe all other files complete before interrupting a stable tree.
    const plan=JSON.parse(await readFile(path.join(f.temporary,'acc-ci-plan.json'),'utf8'));
    let completed=0;
    while(Date.now()<deadline) {
      const reports=(await readdir(f.temporary)).filter(name=>name.startsWith('acc-test-report-'));
      for(const report of reports) {
        const bytes=await readFile(path.join(f.temporary,report,'batch-1.jsonl'),'utf8').catch(()=>'');
        completed=bytes.trim().split('\n').filter(Boolean).length;
      }
      if(completed===plan.selectedFiles.length-1) break;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.equal(completed,plan.selectedFiles.length-1,'other real files must complete before abort');
    child.kill('SIGTERM');
    const result=await closed;
    assert.notEqual(result.code,0);
    assert.equal(await readFile(f.outputPath,'utf8'),'');
    assert.equal((await readdir(f.temporary)).includes('acc-ci-proof.json'),false);
  } finally {
    child.kill('SIGTERM');
    await closed;
    if(owned) await waitForOwnedProcessExit([owned.pid,owned.parent]);
  }
});

// A hard-linked output would corrupt checked bytes only after verification.
test('CLI refuses hard-linked output before publishing its plan',async t=>{
  const f=await ciRunnerFixture(t);
  const alias=path.join(f.base,'output-alias');
  await link(path.join(f.root,'README.md'),alias);
  const result=await f.invoke('plan',{GITHUB_OUTPUT:alias});
  assert.notEqual(result.code,0);
  assert.equal(await f.read('README.md'),'# after\n');
});


for(const [phase,signal] of [['manifest','SIGTERM'],['audit','SIGTERM'],['proof','SIGINT']]) {
  test(`post-run ${phase} interruption ${signal} cannot publish worker proof`,{skip:process.platform==='win32'},async t=>{
    const f=await ciRunnerFixture(t);
    const p=await f.invoke('plan'); assert.equal(p.code,0,p.stderr);
    const injection=await postRunInterruption(f,phase,signal);
    const result=await f.invoke('test',{CI_ROUTE:p.outputs.route,CI_WORKER:f.worker,NODE_OPTIONS:injection.NODE_OPTIONS});
    const observed=JSON.parse(await readFile(injection.marker,'utf8').catch(()=>{assert.fail(JSON.stringify(result));}));
    assert.deepEqual(observed,{phase,signal,listeners:1},'real signal must reach the installed production handler');
    assert.equal((await f.records('docs')).length,1);
    assert.equal((await f.records('smoke')).length,1);
    const manifest=JSON.parse(await readFile(path.join(f.temporary,'acc-test-timings.jsonl.manifest.json'),'utf8'));
    assert.equal(manifest.events.at(-1).result,'passed','runner must finish before this interruption');
    noProof(result);
    assert.equal((await readdir(f.temporary)).includes('acc-ci-selection.json'),true,'interruption retains the owned selection');
  });
}

for (const scope of ['docs', 'full']) test(`retained planner runs real ${scope} retry and aggregate-only retry`, async t => {
  const f = await ciRunnerFixture(t, { scope });
  const p = await f.invoke('plan'); assert.equal(p.code, 0, p.stderr);
  const route = JSON.parse(p.outputs.route); assert.equal(route.runAttempt, '1');
  const suffix = { linux: 'ubuntu-latest', darwin: 'macos-latest', win32: 'windows-latest' }[process.platform];
  const auxiliary = await f.invoke('preflight', { CI_ROUTE: p.outputs.route,
    CI_WORKER: `package-${suffix}`, GITHUB_RUN_ATTEMPT: '2' });
  assert.equal(auxiliary.code, 0, auxiliary.stderr);
  let last;
  for (const attempt of ['1', '2']) {
    last = await f.invoke('test', { CI_ROUTE: p.outputs.route, CI_WORKER: f.worker, GITHUB_RUN_ATTEMPT: attempt });
    assert.equal(last.code, 0, last.stderr);
    const proof = JSON.parse(last.outputs.proof);
    assert.equal(proof.runAttempt, attempt);
    assert.equal(proof.routeDigest, ciRouteDigest(route));
    assert.equal((await f.records('packs')).length, Number(attempt));
    assert.equal((await f.records('smoke')).length, scope === 'docs' ? Number(attempt) : 0);
    assert.equal((await f.records(scope === 'docs' ? 'docs' : 'runtime')).length, Number(attempt));
  }
  // Native full Windows has a second partition; the explicit mixed-shard test covers its aggregate.
  if (scope === 'full' && process.platform === 'win32') return;
  const native = { linux: 'linux', darwin: 'macos', win32: 'windows' }[process.platform];
  const excluded = scope === 'full' ? [`docs-${native}`] : process.platform === 'win32'
    ? ['full-windows-1', 'full-windows-2'] : [`full-${native}`];
  const needs = { plan: { result: 'success', outputs: { route: p.outputs.route } },
    [f.worker]: { result: 'success', outputs: { proof: last.outputs.proof } },
    ...Object.fromEntries(excluded.map(id => [id, { result: 'skipped', outputs: {} }])) };
  const env = { CI_ROUTE: p.outputs.route, CI_PLATFORM: process.platform, CI_NEEDS: JSON.stringify(needs), GITHUB_RUN_ATTEMPT: '3' };
  const result = await f.invoke('aggregate', env); assert.equal(result.code, 0, result.stderr);
  assert.equal((await f.records('packs')).length, 2, 'aggregate retry must not repeat package or tests');
  assert.equal((await f.records(scope === 'docs' ? 'docs' : 'runtime')).length, 2);
  for (const overrides of [{ GITHUB_RUN_ID: '999' }, { GITHUB_RUN_ATTEMPT: '1' },
    { GITHUB_EVENT_NAME: 'workflow_dispatch' }, { CI_ROUTE: JSON.stringify({ ...route, runAttempt: '4' }) }]) {
    noProof(await f.invoke('aggregate', { ...env, ...overrides }));
  }
});

import { createHash } from 'node:crypto';
test('production aggregate CLI accepts mixed Windows success attempts under one retained planner', async t => {
  const f = await ciRunnerFixture(t, { scope: 'full' });
  const p = await f.invoke('plan', { GITHUB_RUN_ATTEMPT: '2' }); assert.equal(p.code, 0, p.stderr);
  const route = JSON.parse(p.outputs.route);
  const plan = JSON.parse(await readFile(path.join(f.temporary, 'acc-ci-plan.json'), 'utf8'));
  const needs = { plan: { result: 'success', outputs: { route: p.outputs.route } }, 'docs-windows': { result: 'skipped', outputs: {} } };
  // Synthetic Windows completion input exercises the real aggregate CLI on every host, not native Windows execution.
  for (const [part, runAttempt] of [[1, '2'], [2, '3']]) {
    const files = plan.selectedFiles.filter((_, i) => i % 2 === part - 1);
    const proof = { schema: 1, workerId: `full-windows-${part}`, routeDigest: ciRouteDigest(route), runId: '1234',
      runAttempt, targetCommit: route.targetCommit, targetTree: route.targetTree, planDigest: route.planDigest,
      scope: 'full', platform: 'win32', node: 'v24.4.0', shard: `${part}/2`, fileCount: files.length,
      filesDigest: createHash('sha256').update(JSON.stringify(files)).digest('hex'), concurrency: 3, fsyncMode: 'real', packageSmoke: false };
    needs[proof.workerId] = { result: 'success', outputs: { proof: JSON.stringify(proof) } };
  }
  const invoke = (n, attempt = '3') => f.invoke('aggregate', { CI_ROUTE: p.outputs.route, CI_PLATFORM: 'win32',
    CI_NEEDS: JSON.stringify(n), GITHUB_RUN_ATTEMPT: attempt });
  assert.equal((await invoke(needs)).code, 0);
  assert.equal((await invoke(needs, '4')).code, 0, 'aggregate-only retry retains both successful shard attempts');
  for (const patch of [{ runAttempt: '1' }, { runAttempt: '4' }, { runId: '999' }, { workerId: 'full-windows-2' },
    { targetCommit: 'f'.repeat(40) }, { routeDigest: 'f'.repeat(64) }]) {
    const broken = structuredClone(needs);
    const proof = JSON.parse(broken['full-windows-1'].outputs.proof);
    broken['full-windows-1'].outputs.proof = JSON.stringify({ ...proof, ...patch });
    noProof(await invoke(broken));
  }
  assert.equal((await f.records('packs')).length, 0);
});
