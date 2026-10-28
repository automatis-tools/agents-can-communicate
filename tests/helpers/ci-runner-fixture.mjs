// Synthetic package/CI context; production planner, CLI, runner and Git byte guard.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pushDocsFixture } from './push-docs-fixture.mjs';
import { run, source } from './change-plan-fixture.mjs';

export async function ciRunnerFixture(t, { scope = 'docs', runnerSuffix = '', runnerOnly = null, testSuffix = '' } = {}) {
  const f = await pushDocsFixture(t, { ci: true });
  const copied = new Set();
  const copy = async file => {
    if (copied.has(file)) return;
    copied.add(file);
    const bytes = await readFile(path.join(source,file), 'utf8');
    await f.write(file,bytes);
    for (const m of bytes.matchAll(/(?:from\s*|import\s*\()(["'])(\.[^"'${}]+\.mjs)\1/g)) {
      const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(file),m[2]));
      // Existing fixture's npm helper deliberately uses the installed npm.
      if (dependency !== 'tests/helpers/npm-run.mjs') await copy(dependency);
    }
  };
  await copy('scripts/ci-validation.mjs');
  // These seams only sabotage the private fixture, never the source runner.
  if (runnerOnly !== null) await f.write('scripts/run-tests.mjs',runnerOnly);
  if (runnerSuffix) await f.write('scripts/run-tests.mjs', (await f.read('scripts/run-tests.mjs')) + runnerSuffix);
  if (testSuffix) await f.write('tests/docs/probe.test.mjs', (await f.read('tests/docs/probe.test.mjs')) + testSuffix);
  await f.write('README.md','# before\n');
  await f.audit();
  const baseCommit = await f.commit('CI audited synthetic fixture');
  await f.write('README.md','# after\n');
  if (scope === 'full') await f.write('tests/runtime.test.mjs',(await f.read('tests/runtime.test.mjs'))+'\n// changed\n');
  const headCommit = await f.commit('CI target');
  const tree = (await f.git(['rev-parse',`${headCommit}^{tree}`])).stdout.trim();
  const targetCommit = (await f.git(['commit-tree',tree,'-p',baseCommit,'-p',headCommit,'-m','validation merge'])).stdout.trim();
  await f.git(['checkout','--detach','-q',targetCommit]);
  const temporary = path.join(f.base,'runner-temp');
  await mkdir(temporary);
  const eventPath = path.join(f.base,'event.json');
  const outputPath = path.join(f.base,'output');
  const event = { number: 17, pull_request: { number: 17, base: { sha: baseCommit }, head: { sha: headCommit } } };
  await writeFile(eventPath,JSON.stringify(event));
  const env = { ...f.env, npm_config_cache: path.join(f.base,'npm-cache'), CI: 'true', GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/17/merge',
    GITHUB_SHA: targetCommit, GITHUB_RUN_ID: '1234', GITHUB_RUN_ATTEMPT: '1', GITHUB_EVENT_PATH: eventPath,
    GITHUB_OUTPUT: outputPath, RUNNER_TEMP: temporary, TMPDIR: temporary, TMP: temporary, TEMP: temporary };
  const worker = `${scope}-${process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux'}${process.platform === 'win32' && scope === 'full' ? '-1' : ''}`;
  return { ...f, repo: f.root, temporary, env, event, eventPath, outputPath, worker,
    invoke: async (mode, overrides = {}) => {
      await writeFile(outputPath,'');
      const result = await run(process.execPath,[path.join(f.root,'scripts/ci-validation.mjs'),mode], {
        cwd: f.root, env: { ...env, ...overrides }, timeout: 30000, maxBuffer: 1024 * 1024,
      }).then(r => ({ ...r, code: 0 }), e => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));
      const text = await readFile(outputPath,'utf8');
      result.outputs = Object.fromEntries(text.trim().split('\n').filter(Boolean).map(line => {
        const index = line.indexOf('='); return [line.slice(0,index),line.slice(index+1)];
      }));
      return result;
    } };
}

// Private preload preserves the actual I/O and delivers an observed real signal
// at the chosen post-run await. Production has no test hook or altered bytes.
export async function postRunInterruption(f, phase, signal) {
  const marker = path.join(f.base,`interrupted-${phase}-${signal}.json`);
  const preload = path.join(f.base,`interrupt-${phase}-${signal}.mjs`);
  await writeFile(preload,`
    import fs from 'node:fs/promises';
    import path from 'node:path';
    import {syncBuiltinESMExports} from 'node:module';
    const read=fs.readFile, write=fs.writeFile;
    const driver=process.argv[1]?.endsWith('/scripts/ci-validation.mjs') && process.argv[2]==='test';
    let delivered=false;
    async function interrupt() {
      if(delivered) return;
      delivered=true;
      const listeners=process.listenerCount(${JSON.stringify(signal)});
      const received=new Promise(resolve=>process.once(${JSON.stringify(signal)},resolve));
      const deadline=setTimeout(()=>{},10000); // Signal watchers alone do not keep Node alive.
      try { process.kill(process.pid,${JSON.stringify(signal)}); await received; }
      finally { clearTimeout(deadline); }
      await write(${JSON.stringify(marker)},JSON.stringify({phase:${JSON.stringify(phase)},signal:${JSON.stringify(signal)},listeners}));
    }
    fs.readFile=async (...args)=>{
      const value=await read(...args);
      const name=path.basename(String(args[0]));
      const atManifest=${JSON.stringify(phase)}==='manifest' && name==='acc-test-timings.jsonl.manifest.json';
      const atAudit=${JSON.stringify(phase)}==='audit' && name==='README.md'
        && await fs.stat(path.join(process.env.RUNNER_TEMP,'acc-test-timings.jsonl.manifest.json')).then(()=>true,()=>false);
      if(driver && (atManifest || atAudit)) await interrupt();
      return value;
    };
    fs.writeFile=async (...args)=>{
      const value=await write(...args);
      if(driver && ${JSON.stringify(phase)}==='proof' && path.basename(String(args[0]))==='acc-ci-proof.json') await interrupt();
      return value;
    };
    syncBuiltinESMExports();
  `);
  const { pathToFileURL } = await import('node:url');
  return { marker, NODE_OPTIONS: `${f.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(preload).href}`.trim() };
}
