import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { removeFixture } from "../helpers/fixture-cleanup.mjs";

const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "../..");
const diagnostic = await import("../../scripts/gate-diagnostics.mjs").catch(() => ({}));

// Removing the whitelist leaks arbitrary environment contents or personal paths.
test("diagnostic manifests persist only closed metadata and repository-relative paths", async t => {
  assert.equal(typeof diagnostic.writeGateDiagnostic, "function", "best-effort diagnostic writer is missing");
  const root = await mkdtemp(path.join(tmpdir(), "acc-diagnostic-"));
  t.after(() => removeFixture(root));
  const destination = path.join(root, "out/manifest.json");
  await diagnostic.writeGateDiagnostic(destination, {
    schema: 1, inputDigest: "b".repeat(64), environment: { SECRET: "do-not-persist" }, cwd: "/Users/private/project",
    receiptDecision: { reused: false, reason: "inputs-uncertain", secret: "do-not-persist" },
    resultCounts: { selected: 2, completed: 1, passed: 1, failed: 0 },
    events: [{ schema: 1, event: "total", durationMs: 5, platform: process.platform, node: process.version,
      fileCount: 2, concurrency: 4, fsyncMode: "real", result: "failed", tree: "a".repeat(40),
      environment: "do-not-persist", scope: "/Users/private/project" }],
    files: [{ file: "tests/probe.test.mjs", durationMs: 2, success: true },
      { file: "/Users/private/test.mjs", durationMs: 1, success: true },
      { file: "../escape.mjs", durationMs: 1, success: true },
      { file: "C:\\private\\test.mjs", durationMs: 1, success: true }],
  });
  const raw = await readFile(destination, "utf8");
  assert.doesNotMatch(raw, /do-not-persist|SECRET|Users|private|escape|environment|cwd/);
  const manifest = JSON.parse(raw);
  assert.deepEqual(manifest.receiptDecision, { reused: false, reason: "inputs-uncertain" });
  assert.deepEqual(manifest.files, [{ file: "tests/probe.test.mjs", durationMs: 2, success: true }]);
  assert.equal(manifest.inputDigest, "b".repeat(64));
  const invalid = path.join(root, "invalid.json");
  await diagnostic.writeGateDiagnostic(invalid, { inputDigest: "/Users/private/secret", events: [] });
  const invalidRecord = JSON.parse(await readFile(invalid, "utf8"));
  assert.equal(invalidRecord.inputDigest, undefined);
  assert.equal(manifest.events[0].scope, undefined);
  assert.equal(manifest.events[0].tree, "a".repeat(40));
  assert.deepEqual(manifest.resultCounts, { selected: 2, completed: 1, passed: 1, failed: 0 });
});

test("optional diagnostic destination failure never rejects validation", async t => {
  assert.equal(typeof diagnostic.writeGateDiagnostic, "function", "best-effort diagnostic writer is missing");
  const root = await mkdtemp(path.join(tmpdir(), "acc-diagnostic-failure-"));
  t.after(() => removeFixture(root));
  const blocker = path.join(root, "regular-file");
  await writeFile(blocker, "block directory creation");
  await assert.doesNotReject(diagnostic.writeGateDiagnostic(path.join(blocker, "manifest.json"), { schema: 1, events: [] }));
});

// Replace only npm pack/install with a fresh empty template. Discovery, actual
// Node test workers, failure propagation, reporter output and cleanup stay real.
async function runnerFixture(t, { reportFault = false } = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-diagnostic-runner-")));
  t.after(() => removeFixture(root));
  for (const directory of ["scripts", "tests", "packages"]) await mkdir(path.join(root, directory));
  const template = path.join(root, "scripts/template.mjs");
  await writeFile(template, `
    import { mkdtemp } from "node:fs/promises";
    import { tmpdir } from "node:os";
    import path from "node:path";
    export const createPackedTemplate = () => mkdtemp(path.join(tmpdir(), "acc-diagnostic-template-"));
  `);
  const batchWrapper = path.join(root, "scripts/batch.mjs");
  if (reportFault) await writeFile(batchWrapper, `
    import { runTestBatch as actualBatch } from ${JSON.stringify(pathToFileURL(path.join(repo, "scripts/test-process.mjs")).href)};
    import { rm, writeFile } from "node:fs/promises";
    export async function runTestBatch(files, options) {
      const result = await actualBatch(files, options);
      if (options.env.PROBE_TIMING_PAYLOAD === "missing") await rm(options.report, { force: true });
      else await writeFile(options.report, options.env.PROBE_TIMING_PAYLOAD);
      return result;
    }
  `);
  const source = (await readFile(path.join(repo, "scripts/run-tests.mjs"), "utf8"))
    .replace(/from (["'])(\.[^"']+)\1/g, (_match, _quote, relative) => {
      const target = relative === "../tests/helpers/packed-template.mjs" ? template
        : reportFault && relative === "./test-process.mjs" ? batchWrapper : path.resolve(repo, "scripts", relative);
      return `from ${JSON.stringify(pathToFileURL(target).href)}`;
    });
  const runner = path.join(root, "scripts/run-tests.mjs");
  await writeFile(runner, source);
  await writeFile(path.join(root, "tests/probe.test.mjs"), `
    import assert from "node:assert/strict";
    import test from "node:test";
    import { readFile, writeFile } from "node:fs/promises";
    test("actual diagnostic worker", async () => {
      assert.notEqual(process.env.PROBE_FAILURE, "1");
      if (process.env.PROBE_INPUT) {
        const bytes = await readFile(process.env.PROBE_INPUT);
        await writeFile(process.env.PROBE_INPUT, "changed input");
        if (process.env.PROBE_RESTORE === "1") await writeFile(process.env.PROBE_INPUT, bytes);
      }
    });
  `);
  const invoke = extra => {
    const env = { ...process.env, CI: "1", ACC_TEST_FORCE_EXIT: "0" };
    for (const name of ["NODE_TEST_CONTEXT", "ACC_TEST_TIMINGS", "ACC_GATE_DIAGNOSTIC", "GITHUB_STEP_SUMMARY"]) delete env[name];
    Object.assign(env, extra);
    return run(process.execPath, [runner], { cwd: root, env, timeout: 30_000 })
      .then(value => ({ ...value, code: 0 }), error => error);
  };
  return { root, invoke };
}

test("runner emits phase timing and actual counts after passing and failing execution", async t => {
  const { root, invoke } = await runnerFixture(t);
  for (const failed of [false, true]) {
    const output = path.join(root, `timings-${failed}.jsonl`);
    const manifest = path.join(root, `manifest-${failed}.json`);
    const result = await invoke({ ACC_TEST_TIMINGS: output, ACC_GATE_DIAGNOSTIC: manifest,
      PROBE_FAILURE: failed ? "1" : "0", PROBE_SECRET: "do-not-persist" });
    assert.equal(result.code, failed ? 1 : 0, result.stdout + result.stderr);
    const raw = await readFile(manifest, "utf8").catch(() => "{}");
    const record = JSON.parse(raw);
    assert.deepEqual(record.receiptDecision, { reused: false, reason: "ci-disabled" }, "runner omitted cache decision");
    assert.equal(record.inputDigest, undefined, "CI fabricated a complete input fingerprint");
    assert.deepEqual(record.resultCounts, { selected: 1, completed: 1, passed: failed ? 0 : 1, failed: failed ? 1 : 0 });
    assert.doesNotMatch(raw, /do-not-persist|PROBE_SECRET|Users|acc-diagnostic-runner-/);
    for (const event of ["fingerprint", "cache-lookup", "packed-template", "batch-execution", "cleanup", "total"]) {
      const phase = record.events.find(item => item.event === event);
      assert.ok(phase, `missing ${event} phase`);
      assert.ok(Number.isFinite(phase.durationMs) && phase.durationMs >= 0);
      assert.equal(phase.fileCount, 1);
      assert.equal(phase.scope, "full");
      assert.equal(phase.platform, process.platform);
      assert.equal(phase.node, process.version);
      assert.ok(phase.concurrency > 0);
    }
    assert.equal(record.events.at(-1).result, failed ? "failed" : "passed");
    assert.equal(record.files[0].file, "tests/probe.test.mjs");
    const files = (await readFile(output, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(files.length, 1, "phase records broke existing timing JSONL consumers");
    assert.equal(files[0].success, !failed);
    assert.equal(typeof files[0].file, "string");
  }
});

test("runner preserves success when optional timings and manifest destinations are unwritable", async t => {
  const { root, invoke } = await runnerFixture(t);
  const blocker = path.join(root, "blocker");
  await writeFile(blocker, "not a directory");
  const result = await invoke({ ACC_TEST_TIMINGS: path.join(blocker, "timings.jsonl"),
    ACC_GATE_DIAGNOSTIC: path.join(blocker, "manifest.json") });
  assert.equal(result.code, 0, result.stdout + result.stderr);
});

// A rejected post-run proof must identify content-key changes separately from
// transient edits restored to the same bytes; neither case changes gate policy.
test("runner explains post-run fingerprint changes separately from observation changes", async t => {
  const { root, invoke } = await runnerFixture(t);
  const output = await mkdtemp(path.join(tmpdir(), "acc-diagnostic-output-"));
  t.after(() => removeFixture(output));
  await writeFile(path.join(root, "input.txt"), "original bytes");
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) delete env[key];
  await run("git", ["init", "-q", root], { env });
  await run("git", ["-C", root, "add", "."], { env });
  for (const restore of [false, true]) {
    const manifest = path.join(output, "manifest.json");
    const result = await invoke({ CI: "", ACC_GATE_DIAGNOSTIC: manifest,
      PROBE_INPUT: path.join(root, "input.txt"), PROBE_RESTORE: restore ? "1" : "0" });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const record = JSON.parse(await readFile(manifest, "utf8"));
    assert.match(record.inputDigest, /^[a-f0-9]{64}$/, "complete working-input fingerprint is missing");
    assert.equal(record.events.find(event => event.event === "receipt-persistence")?.result,
      restore ? "observation-changed" : "fingerprint-changed");
  }
});


// Corrupt only optional report bytes AFTER a real batch has run; its actual
// code must remain authoritative, and unknown outcome counts must be omitted.
test("corrupt or unavailable optional timing metadata preserves the real batch result", async t => {
  const { root, invoke } = await runnerFixture(t, { reportFault: true });
  const output = await mkdtemp(path.join(tmpdir(), "acc-corrupt-report-output-"));
  t.after(() => removeFixture(output));
  const valid = { file: path.join(root, "tests/probe.test.mjs"), durationMs: 1, success: true };
  const payloads = ["{truncated", "null", "42", "{}", JSON.stringify({ ...valid, file: 42 }),
    JSON.stringify({ ...valid, durationMs: "bad" }), JSON.stringify({ ...valid, success: undefined }), "missing",
    JSON.stringify(valid) + "\n{truncated", "{truncated\n" + JSON.stringify(valid)];
  for (const payload of payloads) {
    for (const failed of [false, true]) {
      const manifest = path.join(output, "manifest.json");
      const summary = path.join(output, "summary.md");
      const result = await invoke({ ACC_GATE_DIAGNOSTIC: manifest, GITHUB_STEP_SUMMARY: summary,
        PROBE_TIMING_PAYLOAD: payload, PROBE_FAILURE: failed ? "1" : "0" });
      assert.equal(result.code, failed ? 1 : 0, `metadata ${payload}: ` + result.stdout + result.stderr);
      const record = JSON.parse(await readFile(manifest, "utf8"));
      assert.equal(record.events.at(-1).result, failed ? "failed" : "passed");
      assert.deepEqual(record.resultCounts, { selected: 1 }, "unavailable outcomes were reported as known counts");
      assert.equal(record.files.length, payload.includes("\n") ? 1 : 0);
    }
  }
});

test("workflow diagnostic upload failure is isolated while artifacts remain unconditional and distinct", async () => {
  const names = [];
  for (const workflow of ["ci", "release"]) {
    const source = await readFile(path.join(repo, ".github/workflows", `${workflow}.yml`), "utf8");
    const uploads = source.split(/^      - /m).filter(step => step.includes("uses: actions/upload-artifact@")
      && step.includes("acc-test-timings.jsonl"));
    assert.equal(uploads.length, workflow === "ci" ? 2 : 1);
    for (const upload of uploads) {
      const optional = upload.match(/^        continue-on-error: (.+)$/m)?.[1];
      assert.equal(optional, "true", "failed diagnostic delivery would fail the required job");
      assert.match(upload, /^        if: \$\{\{ always\(\) \}\}$/m);
      names.push(upload.match(/^          name: (.+)$/m)?.[1]);
    }
  }
  assert.equal(new Set(names).size, 3);
});
