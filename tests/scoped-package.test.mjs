import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { runPushCommand } from "../scripts/push-targets.mjs";
import { promisify } from "node:util";
import { removeFixture } from "./helpers/fixture-cleanup.mjs";
const smoke = await import("../scripts/scoped-package.mjs").catch(() => ({}));
const run = promisify(execFile);
async function fixture(t, source = "", { beforeEvidence = "" } = {}) {
  const base = await mkdtemp(path.join(tmpdir(), "acc-smoke-fixture-"));
  const f = { base, cleanupConfirmed: true };
  t.after(() => f.cleanupConfirmed ? removeFixture(base) : undefined);
  const repo = path.join(base, "repo"); const template = path.join(base, "template");
  await mkdir(path.join(repo, "scripts"), { recursive: true }); await mkdir(path.join(template, "pack"), { recursive: true });
  const archive = path.join(template, "pack/exact.tgz"); await writeFile(archive, "exact bytes");
  const evidence = path.join(base, "evidence.json");
  await writeFile(path.join(repo, "scripts/verify-package.mjs"), `import { readFile, writeFile } from 'node:fs/promises';
    ${beforeEvidence}
    await writeFile(${JSON.stringify(evidence)}, JSON.stringify({ args: process.argv.slice(2), tmp: process.env.TMPDIR,
      temp: process.env.TEMP, tmp2: process.env.TMP, pid: process.pid, update: process.env.ACC_NO_UPDATE_CHECK, bytes: await readFile(process.argv[2], 'utf8') })); ${source}`);
  return Object.assign(f, { repo, template, archive, evidence, launcher: path.join(base, "launcher.json") });
}
async function launcherEntry(f) {
  // Keep launcher diagnostics and template until owned teardown succeeds.
  f.cleanupConfirmed = false;
  const entry = path.join(f.base, "run.mjs");
  await writeFile(entry, `import childProcess from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const spawn = childProcess.spawn;
    childProcess.spawn = (file, args, options) => {
      const child = spawn(file, args, options);
      if (file === process.execPath && args[0] === ${JSON.stringify(path.join(f.repo, "scripts/verify-package.mjs"))}) {
        writeFileSync(${JSON.stringify(f.launcher)}, JSON.stringify({ pid: child.pid, tmp: options.env.TMPDIR, args }));
      }
      return child;
    };
    syncBuiltinESMExports();
    const { verifyScopedPackage } = await import(${JSON.stringify(new URL('../scripts/scoped-package.mjs', import.meta.url).href)});
    await verifyScopedPackage(${JSON.stringify({ repo: f.repo, template: f.template })});`);
  return entry;
}
async function cleanupLaunchedVerifier(f) {
  const launched = await readFile(f.launcher, "utf8").then(JSON.parse).catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!launched) return;
  assert.ok(Number.isInteger(launched.pid) && launched.pid > 0, "launcher did not record an owned PID");
  if (process.platform === "win32") {
    await run("taskkill", ["/pid", String(launched.pid), "/t", "/f"], { timeout: 5000 }).catch(() => {});
  } else {
    try { process.kill(-launched.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    try { process.kill(launched.pid, 0); } catch (error) { if (error.code === "ESRCH") break; throw error; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.throws(() => process.kill(launched.pid, 0), { code: "ESRCH" }, "owned cleanup did not confirm exit");
  await removeFixture(launched.tmp);
  f.cleanupConfirmed = true;
}
test("scoped smoke supplies exactly the existing archive and child-only environment, then cleans owned roots", async t => {
  assert.equal(typeof smoke.verifyScopedPackage, "function"); const f = await fixture(t);
  const before = process.env.ACC_NO_UPDATE_CHECK;
  await smoke.verifyScopedPackage(f);
  const evidence = JSON.parse(await readFile(f.evidence));
  assert.deepEqual(evidence.args, [f.archive]); assert.equal(evidence.bytes, "exact bytes"); assert.equal(evidence.update, "1");
  assert.equal(evidence.tmp, evidence.temp); assert.equal(evidence.tmp, evidence.tmp2); assert.equal(process.env.ACC_NO_UPDATE_CHECK, before);
  await assert.rejects(lstat(evidence.tmp), { code: "ENOENT" }); await assert.rejects(lstat(f.template), { code: "ENOENT" });
});
test("ordinary smoke failure cleans both roots and fails", async t => {
  assert.equal(typeof smoke.verifyScopedPackage, "function"); const f = await fixture(t, "process.exitCode = 7;");
  await assert.rejects(smoke.verifyScopedPackage(f));
  const { tmp } = JSON.parse(await readFile(f.evidence)); await assert.rejects(lstat(tmp), { code: "ENOENT" });
  await assert.rejects(lstat(f.template), { code: "ENOENT" });
});
test("missing, multiple, directory and symlink archives refuse smoke", async t => {
  assert.equal(typeof smoke.verifyScopedPackage, "function");
  for (const variant of ["missing", "multiple", "directory", ...(process.platform === "win32" ? [] : ["symlink"])]) {
    const f = await fixture(t); if (variant !== "multiple") await rm(f.archive);
    if (variant === "multiple") await writeFile(path.join(f.template, "pack/extra.tgz"), "extra");
    if (variant === "directory") await mkdir(f.archive);
    if (variant === "symlink") await symlink(f.evidence, f.archive);
    await assert.rejects(smoke.verifyScopedPackage(f), /archive/);
    await assert.rejects(lstat(f.evidence), { code: "ENOENT" });
  }
});
test("deadline is bounded and retains interrupted template and child temporary root", async t => {
  assert.equal(typeof smoke.verifyScopedPackage, "function"); const f = await fixture(t, "", {
    beforeEvidence: "await new Promise(() => setInterval(() => {}, 1000));",
  });
  const entry = await launcherEntry(f);
  try {
    const result = await run(process.execPath, [entry], { env: { ...process.env, ACC_TEST_FILE_TIMEOUT_MS: "200" }, timeout: 10_000 })
      .then(() => ({ code: 0 }), error => error);
    assert.notEqual(result.code, 0); assert.match(result.stderr, /deadline|interrupted/);
    const launched = JSON.parse(await readFile(f.launcher));
    assert.deepEqual(launched.args, [path.join(f.repo, "scripts/verify-package.mjs"), f.archive]);
    assert.ok((await lstat(launched.tmp)).isDirectory()); assert.ok((await lstat(f.template)).isDirectory());
    await assert.rejects(lstat(f.evidence), { code: "ENOENT" });
    assert.throws(() => process.kill(launched.pid, 0), { code: "ESRCH" });
  } finally {
    await cleanupLaunchedVerifier(f);
  }
});
test("SIGTERM waits for owned process termination and retains resources", { skip: process.platform === "win32" }, async t => {
  assert.equal(typeof smoke.verifyScopedPackage, "function"); const f = await fixture(t, "setInterval(() => {}, 1000);");
  const entry = path.join(f.base, "run.mjs");
  await writeFile(entry, `import { verifyScopedPackage } from ${JSON.stringify(new URL('../scripts/scoped-package.mjs', import.meta.url).href)};
    await verifyScopedPackage(${JSON.stringify({ repo: f.repo, template: f.template })});`);
  const child = spawn(process.execPath, [entry], { stdio: "ignore" });
  const completed = new Promise(resolve => child.once("exit", resolve));
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await lstat(f.evidence).catch(() => false)) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  child.kill("SIGTERM");
  await Promise.race([completed, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error("cancellation hung")), 8000); timer.unref(); })]);
  const evidence = JSON.parse(await readFile(f.evidence)); assert.ok((await lstat(f.template)).isDirectory());
  assert.ok((await lstat(evidence.tmp)).isDirectory());
  assert.throws(() => process.kill(evidence.pid, 0), { code: "ESRCH" }); await removeFixture(evidence.tmp);
});


test("Windows taskkill without a close event has bounded completion and reports unconfirmed termination", async () => {
  const controller = new AbortController(); let child; let killer;
  const spawnCommand = (file, args) => {
    const value = new EventEmitter(); value.unref = () => {};
    if (file === "taskkill") { killer = value; assert.deepEqual(args, ["/pid", "12345", "/t", "/f"]); }
    else {
      child = value; value.pid = 12345;
      for (const name of ["stdin", "stdout", "stderr"]) value[name] = new PassThrough();
    }
    return value;
  };
  const execution = runPushCommand("node", [], { cwd: process.cwd(), signal: controller.signal, platform: "win32", spawnCommand });
  controller.abort(); await assert.rejects(execution, { code: "PUSH_TERMINATION_UNCONFIRMED" });
  assert.ok(killer); assert.equal(child.stdout.destroyed, true);
});

test("confirmed teardown rejects interruption without waiting for inherited output close", async () => {
  const controller = new AbortController(); let child; let killer; let kills = 0;
  const spawnCommand = file => {
    const value = new EventEmitter(); value.unref = () => {};
    if (file === "taskkill") { killer = value; kills++; }
    else { child = value; value.pid = 12345; for (const name of ["stdin", "stdout", "stderr"]) value[name] = new PassThrough(); }
    return value;
  };
  const execution = runPushCommand("node", [], { cwd: process.cwd(), signal: controller.signal, platform: "win32", spawnCommand });
  controller.abort(); controller.abort(); killer.emit("close", 0);
  let timer;
  try {
    await assert.rejects(Promise.race([execution, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error("abort waited for inherited pipes")), 500);
    })]), /push validation interrupted/);
  } finally { clearTimeout(timer); }
  assert.equal(kills, 1); assert.equal(child.stdout.destroyed, true);
  child.emit("close", 0); // A later zero exit cannot turn an aborted command green.
});

test("unconfirmed termination retains both roots while its owned verifier remains alive", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t, "", { beforeEvidence: "await new Promise(() => setInterval(() => {}, 1000));" });
  const entry = await launcherEntry(f);
  try {
    // Deny ps discovery without replacing process ownership or teardown code.
    const result = await run(process.execPath, [entry], { env: { ...process.env, PATH: "", ACC_TEST_FILE_TIMEOUT_MS: "200" }, timeout: 10_000 })
      .then(() => ({ code: 0 }), error => error);
    assert.notEqual(result.code, 0); assert.match(result.stderr, /termination unconfirmed/);
    const launched = JSON.parse(await readFile(f.launcher));
    assert.deepEqual(launched.args, [path.join(f.repo, "scripts/verify-package.mjs"), f.archive]);
    assert.doesNotThrow(() => process.kill(launched.pid, 0), "fixture did not retain a live owned process");
    assert.ok((await lstat(f.template)).isDirectory()); assert.ok((await lstat(launched.tmp)).isDirectory());
    await assert.rejects(lstat(f.evidence), { code: "ENOENT" });
  } finally {
    await cleanupLaunchedVerifier(f);
  }
});
