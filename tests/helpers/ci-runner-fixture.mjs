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
