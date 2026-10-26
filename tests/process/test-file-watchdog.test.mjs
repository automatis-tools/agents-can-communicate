import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";
import { nodeTestArguments } from "../../scripts/test-runner-plan.mjs";
import { runTestBatch } from "../../scripts/test-process.mjs";
import { removeFixture } from "../helpers/fixture-cleanup.mjs";

const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "../..");
const environment = extra => {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  return env;
};

test("a successful assertion cannot hold its file process open beyond the file deadline", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "acc-file-deadline-"));
  t.after(() => removeFixture(root));
  const file = path.join(root, "leaked-handle.test.mjs");
  await writeFile(file, 'import test from "node:test";\ntest("assertion passed", () => {});\nsetTimeout(() => {}, 1500);\n');
  // An existing CI force-exit would hide the handle, and cannot be the witness.
  const args = nodeTestArguments([file]).filter(argument => argument !== "--test-force-exit");
  const result = await run(process.execPath, args, {
    cwd: repo, env: environment({ ACC_TEST_FILE_TIMEOUT_MS: "100", ACC_TEST_FORCE_EXIT: "0" }), timeout: 10_000,
  }).then(value => ({ ...value, code: 0 }), error => error);
  assert.equal(result.code, 1, "a passed test file kept the process alive past its deadline");
  assert.match(result.stdout + result.stderr, /leaked-handle\.test\.mjs.*100 ms|100 ms.*leaked-handle\.test\.mjs/);
});

test("the file deadline names the resources that kept the file alive", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "acc-file-holders-"));
  t.after(() => removeFixture(root));
  const file = path.join(root, "held-by-server.test.mjs");
  await writeFile(file, 'import net from "node:net";\nimport test from "node:test";\n'
    + 'test("assertion passed", () => {});\nnet.createServer().listen(0, "127.0.0.1");\n');
  const args = nodeTestArguments([file]).filter(argument => argument !== "--test-force-exit");
  const result = await run(process.execPath, args, {
    cwd: repo, env: environment({ ACC_TEST_FILE_TIMEOUT_MS: "300", ACC_TEST_FORCE_EXIT: "0" }), timeout: 10_000,
  }).then(value => ({ ...value, code: 0 }), error => error);
  assert.equal(result.code, 1);
  assert.match(result.stdout + result.stderr, /kept alive by: .*TCPServerWrap/);
});

test("completed files exit naturally and do not wait for the watchdog", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "acc-file-complete-"));
  t.after(() => removeFixture(root));
  const file = path.join(root, "complete.test.mjs");
  await writeFile(file, 'import test from "node:test";\ntest("finished", () => {});\n');
  const result = await run(process.execPath, nodeTestArguments([file]), {
    cwd: repo, env: environment({ ACC_TEST_FILE_TIMEOUT_MS: "30000" }), timeout: 15000,
  });
  assert.match(result.stdout, /finished/);
});

test("the parent deadline closes descendant-held pipes and terminates its test process tree", async t => {
  const inheritedExit = process.env.ACC_TEST_FORCE_EXIT;
  process.env.ACC_TEST_FORCE_EXIT = "1";
  t.after(() => {
    if (inheritedExit === undefined) delete process.env.ACC_TEST_FORCE_EXIT;
    else process.env.ACC_TEST_FORCE_EXIT = inheritedExit;
  });
  const root = await mkdtemp(path.join(tmpdir(), "acc-descendant-deadline-"));
  const pidFile = path.join(root, "descendant.pid");
  let descendant;
  t.after(async () => {
    descendant ??= Number(await readFile(pidFile, "utf8").catch(() => "0"));
    if (Number.isSafeInteger(descendant) && descendant > 0) {
      try { process.kill(descendant, "SIGKILL"); } catch {}
    }
    await removeFixture(root);
  });
  // Not named *.test.mjs: the in-file watchdog would end the file first, and
  // this case is about what the parent deadline does with a surviving pipe.
  const file = path.join(root, "inherited-pipe.mjs");
  await writeFile(file, `import { spawn } from "node:child_process";
    import test from "node:test";
    import { writeFileSync } from "node:fs";
    test(import.meta.filename, () => {});
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 12000)"], { stdio: "inherit" });
    writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
    child.unref();
    console.log("descendant holds pipes");
    setInterval(() => {}, 1000);
  `);
  let output = "";
  let errors = "";
  const started = performance.now();
  const result = await runTestBatch([file], { cwd: repo,
    env: environment({ ACC_TEST_FILE_TIMEOUT_MS: "3000", ACC_TEST_FORCE_EXIT: "0" }),
    report: path.join(root, "timings.jsonl"),
    output: { write: chunk => { output += chunk; } }, errorOutput: { write: chunk => { errors += chunk; } },
  });
  assert.equal(result.code, 1);
  assert.match(output, /descendant holds pipes/, "fixture never reached the inherited-pipe condition");
  assert.match(errors, /inherited-pipe\.mjs.*3000 ms/);
  assert.ok(performance.now() - started < 9000, "gate waited for the surviving descendant");
  descendant = Number(await readFile(pidFile, "utf8"));
  const alive = async () => {
    try { process.kill(descendant, 0); } catch (error) { if (error.code === "ESRCH") return false; throw error; }
    if (process.platform === "win32") return true;
    const { stdout } = await run("ps", ["-p", String(descendant), "-o", "stat="])
      .catch(() => ({ stdout: "" }));
    return stdout.trim() !== "" && !stdout.trim().startsWith("Z");
  };
  const end = Date.now() + 2000;
  while (await alive() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(await alive(), false, "deadline left its descendant running");
  descendant = 0;
});

// The spec reporter prints a failure's message only in its closing summary, and
// the parent deadline kills the runner before that summary. A failed test whose
// cleanup then holds the file open lost its reason (#318's ubuntu job, run
// 39718605689). The fixture is not named *.test.mjs, so the in-file watchdog
// cannot end it first and let the summary through: only the parent deadline acts.
test("a failure stays visible when its file is terminated at the parent deadline", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "acc-failure-deadline-"));
  t.after(() => removeFixture(root));
  const file = path.join(root, "held-open-after-failure.mjs");
  await writeFile(file, `import assert from "node:assert/strict";
    import test from "node:test";
    test("fails, then leaves a handle", () => {
      setInterval(() => {}, 1000);
      assert.equal(1, 2, "fixture assertion text");
    });
  `);
  let output = "";
  const result = await runTestBatch([file], { cwd: repo,
    env: environment({ ACC_TEST_FILE_TIMEOUT_MS: "3000", ACC_TEST_FORCE_EXIT: "0" }),
    report: path.join(root, "timings.jsonl"),
    output: { write: chunk => { output += chunk; } }, errorOutput: { write: chunk => { output += chunk; } },
  });
  assert.equal(result.code, 1);
  assert.match(output, /terminating test process tree/, "the parent deadline never acted");
  assert.match(output, /fails, then leaves a handle/);
  assert.match(output, /fixture assertion text/);
});

test("a batch applies its own per-test deadline instead of the parent's environment", async t => {
  const inheritedTimeout = process.env.ACC_TEST_TIMEOUT_MS;
  process.env.ACC_TEST_TIMEOUT_MS = "300000";
  t.after(() => {
    if (inheritedTimeout === undefined) delete process.env.ACC_TEST_TIMEOUT_MS;
    else process.env.ACC_TEST_TIMEOUT_MS = inheritedTimeout;
  });
  const root = await mkdtemp(path.join(tmpdir(), "acc-batch-test-deadline-"));
  t.after(() => removeFixture(root));
  const file = path.join(root, "slow.test.mjs");
  await writeFile(file, 'import test from "node:test";\ntest("slow assertion", async () => { await new Promise(resolve => setTimeout(resolve, 600)); });\n');
  let output = "";
  const result = await runTestBatch([file], { cwd: repo,
    env: environment({ ACC_TEST_TIMEOUT_MS: "50", ACC_TEST_FILE_TIMEOUT_MS: "3000", ACC_TEST_FORCE_EXIT: "0" }),
    report: path.join(root, "timings.jsonl"),
    output: { write: chunk => { output += chunk; } }, errorOutput: { write: chunk => { output += chunk; } },
  });
  assert.equal(result.code, 1, "the batch ignored its explicit per-test deadline");
  assert.match(output, /test timed out after 50ms/);
});

// The reporter writes a failure to stderr and then sends the deadline message
// over IPC. On Linux the parent read the IPC message first, destroyed stderr
// at once and lost the failure (#318, run 40266451682). The fake child delivers
// the two in that order.
test("output that arrives after the deadline message is still read before the batch ends", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "acc-deadline-drain-"));
  t.after(() => removeFixture(root));
  const file = path.join(root, "late-output.test.mjs");
  await writeFile(file, "");
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(),
    stderr: new PassThrough(), pid: undefined, connected: false, kill() {}, disconnect() {} });
  let errors = "";
  let spawned;
  const started = new Promise(resolve => { spawned = resolve; });
  const finished = runTestBatch([file], { cwd: repo,
    env: environment({ ACC_TEST_FILE_TIMEOUT_MS: "3000" }), report: path.join(root, "timings.jsonl"),
    output: { write: () => {} }, errorOutput: { write: chunk => { errors += chunk; } },
    spawnChild: () => { setImmediate(spawned); return child; } });
  // The batch resolves the file's real path before it starts the child.
  await started;
  child.emit("message", { type: "acc-test-file-deadline", file: await realpath(file), timeoutMs: 3000 });
  await new Promise(resolve => setImmediate(resolve));
  child.stderr.end("failed before the file deadline: fixture\n");
  child.stdout.end();

  const result = await finished;

  assert.equal(result.code, 1);
  assert.match(errors, /failed before the file deadline: fixture/);
});

// Node reports a file's tests to reporters when the file ends, so a reporter
// cannot see a failure in a file that hangs, and a parent kill also loses what
// the file printed (#327's ubuntu job). The in-file watchdog acts first: the
// file ends itself, and the run's closing summary names the failure as usual.
test("a hanging file ends itself before the parent deadline, and its failure is summarised", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "acc-file-first-"));
  t.after(() => removeFixture(root));
  const file = path.join(root, "fails-then-hangs.test.mjs");
  await writeFile(file, `import assert from "node:assert/strict";
    import test from "node:test";
    test("fails, then leaves a handle", () => {
      setInterval(() => {}, 1000);
      assert.equal(1, 2, "fixture assertion text");
    });
  `);
  let output = "";
  const result = await runTestBatch([file], { cwd: repo,
    env: environment({ ACC_TEST_FILE_TIMEOUT_MS: "3000", ACC_TEST_FORCE_EXIT: "0" }),
    report: path.join(root, "timings.jsonl"),
    output: { write: chunk => { output += chunk; } }, errorOutput: { write: chunk => { output += chunk; } },
  });
  assert.equal(result.code, 1);
  assert.doesNotMatch(output, /terminating test process tree/, "the parent deadline had to act");
  assert.match(output, /kept alive by: .*Timeout/);
  assert.match(output, /fixture assertion text/);
});
