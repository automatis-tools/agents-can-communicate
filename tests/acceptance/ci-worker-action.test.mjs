import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileConcurrency, nodeTestArguments, skipsFsync, testEnvironment, testFileTimeout } from '../../scripts/test-runner-plan.mjs';

const repo = path.resolve(import.meta.dirname, '../..');
const action = () => readFile(path.join(repo, '.github/actions/ci-test/action.yml'), 'utf8');
const evaluate = (value, context) => vm.runInNewContext(value.replace(/^\$\{\{|\}\}$/g, ''), context);
const scalar = (source, key) => {
  const value = source.match(new RegExp(`^\\s+${key}: (.+)$`, 'm'))?.[1];
  assert.notEqual(value, undefined, `missing ${key}`);
  return value;
};

test('the composite publishes proof only from the production test-driver step', async () => {
  const source = await action();
  assert.match(source, /using: composite/);
  for (const input of ['route', 'worker', 'artifact']) assert.match(source, new RegExp(`^  ${input}:\\n`, 'm'));
  assert.equal(scalar(source, 'value'), '${{ steps.test.outputs.proof }}');
  const steps = source.split(/^    - /m).slice(1);
  const driver = steps.find(s => s.includes('id: test'));
  assert.ok(driver);
  assert.equal(scalar(driver, 'run'), 'node scripts/ci-validation.mjs test');
  assert.equal(scalar(driver, 'CI_ROUTE'), '${{ inputs.route }}');
  assert.equal(scalar(driver, 'CI_WORKER'), '${{ inputs.worker }}');
  assert.doesNotMatch(source, /--if-needed|--selection-plan|--shard|GITHUB_OUTPUT|continue-on-error: true[\s\S]*id: test/);
  const install = steps.find(s => s.includes('run: npm ci'));
  assert.ok(install && steps.indexOf(install) < steps.indexOf(driver));
  assert.match(source, /uses: actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020/);
  assert.equal(scalar(source, 'node-version'), "'24'");
  for (const step of steps.filter(s => /\brun:/.test(s))) assert.ok(['bash', 'pwsh'].includes(scalar(step, 'shell')));
  const upload = steps.find(s => s.includes('uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a'));
  assert.ok(upload && steps.indexOf(upload) > steps.indexOf(driver));
  assert.equal(scalar(upload, 'continue-on-error'), 'true');
  // A bare true still inherits Actions' implicit success() status check.
  assert.match(scalar(upload, 'if'), /^\$\{\{\s*always\(\)\s*\}\}$/);
  const name = scalar(upload, 'name');
  for (const [attempt, want] of [[1, 'timing-full'], [2, 'timing-full-attempt-2'], [3, 'timing-full-attempt-3']]) {
    const actual = evaluate(name, { inputs: { artifact: 'timing-full' }, github: { run_attempt: attempt },
      format: (pattern, artifact, number) => pattern.replace('{0}', artifact).replace('{1}', String(number)) });
    assert.equal(actual, want);
  }
  assert.doesNotMatch(upload, /overwrite: true/);
  for (const file of ['acc-test-timings.jsonl', 'acc-test-timings.jsonl.manifest.json', 'acc-ci-plan.json', 'acc-ci-proof.json']) {
    assert.ok(upload.includes(`\${{ runner.temp }}/${file}\n`));
  }
});

test('literal action deadlines and CI keep the actual runner bounded and durable', async () => {
  const source = await action();
  const driver = source.split(/^    - /m).find(s => s.includes('id: test'));
  assert.ok(driver);
  const literal = Object.fromEntries([...driver.matchAll(/^        (\w+): '([^']*)'$/gm)].map(([, k, v]) => [k, v]));
  assert.equal(literal.CI, 'true');
  assert.equal(literal.ACC_TEST_TIMEOUT_MS, '300000');
  assert.equal(literal.ACC_TEST_FILE_TIMEOUT_MS, '600000');
  assert.equal(literal.GIT_DIR, '');
  assert.equal(literal.GIT_WORK_TREE, '');
  assert.equal(scalar(driver, 'ACC_TEST_TIMINGS'), '${{ runner.temp }}/acc-test-timings.jsonl');
  for (const [platform, os, concurrency] of [['linux', 'Linux', 4], ['darwin', 'macOS', 4], ['win32', 'Windows', 3]]) {
    const env = { ...literal, ACC_TEST_FORCE_EXIT: evaluate(scalar(driver, 'ACC_TEST_FORCE_EXIT'), { runner: { os } }) };
    const actual = testEnvironment(env, { platform });
    assert.equal(skipsFsync({ env: actual, platform }), false);
    assert.equal(fileConcurrency(platform, { fsyncSkipped: skipsFsync({ env: actual, platform }) }), concurrency);
    const args = nodeTestArguments(['probe.test.mjs'], { env: actual });
    assert.ok(args.includes('--test-timeout=300000'));
    assert.equal(testFileTimeout(actual), 600000);
    assert.equal(args.includes('--test-force-exit'), platform === 'win32');
  }
});

test('all Windows workers use local fixture temp before the driver', async () => {
  const source = await action();
  const steps = source.split(/^    - /m).slice(1);
  const temporary = steps.find(s => s.includes('Temporary files on the local disk'));
  assert.ok(temporary);
  assert.equal(scalar(temporary, 'shell'), 'pwsh');
  for (const os of ['Windows', 'Linux', 'macOS']) assert.equal(evaluate(scalar(temporary, 'if'), { runner: { os } }), os === 'Windows');
  assert.match(temporary, /Join-Path \$env:RUNNER_TEMP 'tmp'/);
  assert.match(temporary, /New-Item -ItemType Directory -Force \$dir/);
  for (const key of ['TEMP', 'TMP']) assert.ok(temporary.includes(`"${key}=$dir" >> $env:GITHUB_ENV`));
  assert.ok(steps.indexOf(temporary) < steps.findIndex(s => s.includes('id: test')));
});
