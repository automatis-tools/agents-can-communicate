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
async function fixture(t, source = "") {
  const base = await mkdtemp(path.join(tmpdir(), "acc-smoke-fixture-")); t.after(() => removeFixture(base));
  const repo = path.join(base, "repo"); const template = path.join(base, "template");
  await mkdir(path.join(repo, "scripts"), { recursive: true }); await mkdir(path.join(template, "pack"), { recursive: true });
  const archive = path.join(template, "pack/exact.tgz"); await writeFile(archive, "exact bytes");
  const evidence = path.join(base, "evidence.json");
  await writeFile(path.join(repo, "scripts/verify-package.mjs"), `import { readFile, writeFile } from 'node:fs/promises';
    await writeFile(${JSON.stringify(evidence)}, JSON.stringify({ args: process.argv.slice(2), tmp: process.env.TMPDIR,
      temp: process.env.TEMP, tmp2: process.env.TMP, pid: process.pid, update: process.env.ACC_NO_UPDATE_CHECK, bytes: await readFile(process.argv[2], 'utf8') })); ${source}`);
  return { base, repo, template, archive, evidence };
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
  assert.equal(typeof smoke.verifyScopedPackage, "function"); const f = await fixture(t, "setInterval(() => {}, 1000);");
  const entry = path.join(f.base, "run.mjs");
  await writeFile(entry, `import { verifyScopedPackage } from ${JSON.stringify(new URL('../scripts/scoped-package.mjs', import.meta.url).href)};
    await verifyScopedPackage(${JSON.stringify({ repo: f.repo, template: f.template })});`);
  const result = await run(process.execPath, [entry], { env: { ...process.env, ACC_TEST_FILE_TIMEOUT_MS: "200" }, timeout: 10_000 })
    .then(() => ({ code: 0 }), error => error);
  assert.notEqual(result.code, 0); assert.match(result.stderr, /deadline|interrupted/);
  const evidence = JSON.parse(await readFile(f.evidence)); assert.ok((await lstat(evidence.tmp)).isDirectory());
  assert.ok((await lstat(f.template)).isDirectory());
  assert.throws(() => process.kill(evidence.pid, 0), { code: "ESRCH" }); await removeFixture(evidence.tmp);
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
  const f = await fixture(t, "setInterval(() => {}, 1000);");
  const entry = path.join(f.base, "run.mjs");
  await writeFile(entry, `import { verifyScopedPackage } from ${JSON.stringify(new URL('../scripts/scoped-package.mjs', import.meta.url).href)};
    await verifyScopedPackage(${JSON.stringify({ repo: f.repo, template: f.template })});`);
  let pid;
  let temporary;
  try {
    // Deny ps discovery without replacing process ownership or teardown code.
    const result = await run(process.execPath, [entry], { env: { ...process.env, PATH: "", ACC_TEST_FILE_TIMEOUT_MS: "200" }, timeout: 10_000 })
      .then(() => ({ code: 0 }), error => error);
    assert.notEqual(result.code, 0); assert.match(result.stderr, /termination unconfirmed/);
    const evidence = JSON.parse(await readFile(f.evidence)); pid = evidence.pid; temporary = evidence.tmp;
    assert.doesNotThrow(() => process.kill(pid, 0), "fixture did not retain a live owned process");
    assert.ok((await lstat(f.template)).isDirectory()); assert.ok((await lstat(temporary)).isDirectory());
  } finally {
    if (!pid) pid = JSON.parse(await readFile(f.evidence).catch(() => "{}")).pid;
    if (pid) {
      try { process.kill(-pid, "SIGKILL"); } catch { /* Already stopped. */ }
      for (let attempt = 0; attempt < 100; attempt++) {
        try { process.kill(pid, 0); } catch { break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "owned cleanup did not confirm exit");
    }
    if (temporary) await removeFixture(temporary);
  }
});
