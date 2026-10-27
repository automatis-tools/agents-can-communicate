// Restoring cleanup after an interrupted command deletes bytes beneath workers
// whose launcher exited before cancellation; an abort-time snapshot cannot own them.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { fixture } from "../helpers/push-fixture.mjs";
import { withPushCheckout } from "../../scripts/push-targets.mjs";

const exec = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, description) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(10);
  }
  assert.fail(description);
}
async function table() {
  const { stdout } = await exec("ps", ["-A", "-o", "pid=,ppid=,pgid=,stat="]);
  return new Map(stdout.trim().split("\n").map(line => {
    const [pid, parent, group, state] = line.trim().split(/\s+/);
    return [Number(pid), { pid: Number(pid), parent: Number(parent), group: Number(group), state }];
  }));
}
const live = row => row && !/Z/.test(row.state);
async function removeCheckout(f, owned) {
  if (!owned) return;
  if (await f.exists(owned)) await f.git(["worktree", "remove", "--force", owned]);
  await rm(path.dirname(owned), { recursive: true, force: true });
}

for (const checkout of ["isolated", "current"]) {
  test(`handled interruption preserves the ${checkout} checkout`, async t => {
    const f = await fixture(t);
    let owned;
    try {
      await assert.rejects(withPushCheckout(f.root, { commit: await f.oid(), checkout }, async (cwd, signal) => {
        owned = cwd;
        process.emit("SIGTERM");
        assert.equal(signal.aborted, true);
      }), checkout === "isolated" ? /interrupted.*checkout retained/ : /interrupted/);
      assert.equal(await f.read("module.mjs", owned), "export {};\n");
      assert.equal((await f.git(["worktree", "list", "--porcelain"])).stdout.match(/^worktree /gm).length,
        checkout === "isolated" ? 2 : 1);
    } finally {
      if (checkout === "isolated") await removeCheckout(f, owned);
    }
  });
}

test("normal completion removes its owned checkout", async t => {
  const f = await fixture(t);
  let owned;
  try {
    await withPushCheckout(f.root, { commit: await f.oid(), checkout: "isolated" }, async cwd => {
      owned = cwd;
      assert.equal(await f.read("module.mjs", cwd), "export {};\n");
    });
    assert.equal(await f.exists(owned), false);
    assert.equal((await f.git(["worktree", "list", "--porcelain"])).stdout.match(/^worktree /gm).length, 1);
  } finally { await removeCheckout(f, owned); }
});

test("interruption retains bytes for a detached worker reparented before cancellation",
  { timeout: 30000, skip: process.platform === "win32" }, async t => {
    const f = await fixture(t);
    const heartbeat = path.join(f.base, "heartbeat.json");
    const launcherExit = path.join(f.base, "launcher-exited");
    const npmMarker = path.join(f.base, "npm");
    const workerMarker = path.join(f.base, "worker");
    const requiredBytes = "export const required = 'history-checkout-bytes';\n";
    await writeFile(path.join(f.root, "module.mjs"), requiredBytes);
    await writeFile(path.join(f.root, "worker.mjs"), `import {readFileSync,writeFileSync} from 'node:fs';
      let count=0;
      setInterval(()=>{ let bytes; try { bytes=readFileSync('module.mjs','utf8'); } catch { bytes=null; }
        writeFileSync(${JSON.stringify(heartbeat)},JSON.stringify({pid:process.pid,parent:process.ppid,count:++count,bytes})); },20);`);
    await writeFile(path.join(f.root, "launcher.mjs"), `import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs';
      const worker=spawn(process.execPath,['worker.mjs'],{detached:true,stdio:'ignore'});
      writeFileSync(${JSON.stringify(workerMarker)},String(worker.pid)); worker.unref();`);
    await writeFile(path.join(f.root, "target.test.mjs"), `import {spawn} from 'node:child_process';
      import {writeFileSync} from 'node:fs';
      const launcher=spawn(process.execPath,['launcher.mjs'],{stdio:'ignore'});
      launcher.once('exit',code=>{if(code!==0)process.exit(1);writeFileSync(${JSON.stringify(launcherExit)},String(launcher.pid));});
      setInterval(()=>{},1000);`);
    const oid = await f.commit("worker outlives its launcher");
    const helper = pathToFileURL(path.resolve(import.meta.dirname, "../../scripts/push-targets.mjs")).href;
    const source = `import {withPushCheckout,runPushCommand} from ${JSON.stringify(helper)};
      import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs';
      try { await withPushCheckout(process.cwd(),{commit:${JSON.stringify(oid)},checkout:'isolated'},async(cwd,signal)=>{
        console.log('READY '+cwd); await runPushCommand('npm',['test'],{cwd,signal,spawnCommand:(...args)=>{
          const child=spawn(...args);writeFileSync(${JSON.stringify(npmMarker)},String(child.pid));return child;
        }});
      }); } catch(error) {console.error(error.message);process.exitCode=1;}`;
    const env = { ...f.env };
    delete env.CODEX_HOME;
    delete env.AGENTS_HOME;
    const validator = spawn(process.execPath, ["--input-type=module", "-e", source], { cwd: f.root, env });
    let stdout = "";
    let stderr = "";
    validator.stdout.on("data", bytes => { stdout += bytes; });
    validator.stderr.on("data", bytes => { stderr += bytes; });
    const closed = new Promise(resolve => validator.once("close", resolve));
    let owned;
    let npmPid;
    let workerPid;
    try {
      owned = await until(async () => stdout.match(/READY (.+)/)?.[1].trim(), "isolated checkout never ready");
      await until(() => f.exists(launcherExit), `launcher never exited: ${stderr}`);
      npmPid = Number(await readFile(npmMarker, "utf8"));
      const launcherPid = Number(await readFile(launcherExit, "utf8"));
      workerPid = Number(await until(() => readFile(workerMarker, "utf8").catch(() => ""), "worker never started"));
      const before = await until(async () => {
        const rows = await table();
        const worker = rows.get(workerPid);
        if (rows.has(launcherPid) || !live(worker) || worker.parent === launcherPid) return;
        assert.ok(live(rows.get(npmPid)), "npm exited before cancellation");
        assert.equal(worker.group, workerPid, "worker did not detach into its own group");
        const related = new Set([npmPid]);
        for (let changed = true; changed;) {
          changed = false;
          for (const row of rows.values()) if (related.has(row.parent) && !related.has(row.pid)) {
            related.add(row.pid); changed = true;
          }
        }
        assert.equal(related.has(workerPid), false, "worker was still discoverable under npm");
        const beat = await readFile(heartbeat, "utf8").then(JSON.parse).catch(() => null);
        if (beat?.bytes !== requiredBytes || beat.parent !== worker.parent) return;
        t.diagnostic(`before abort: npm=${npmPid}, exited launcher=${launcherPid}, worker=${JSON.stringify(worker)}, heartbeat=${beat.count}`);
        return beat;
      }, "worker never became a reparented checkout reader");
      validator.kill("SIGTERM");
      assert.notEqual(await closed, 0, "interruption was falsely successful");
      const rows = await table();
      assert.ok(!live(rows.get(npmPid)), "visible npm process survived cancellation");
      assert.ok(live(rows.get(workerPid)), "fixture did not reproduce a live escaped worker");
      t.diagnostic(`after abort: escaped worker alive; checkout exists=${await f.exists(owned)}; ${stderr.trim()}`);
      assert.equal(await f.exists(owned), true, "interrupted checkout was deleted beneath the escaped worker");
      assert.equal(await f.read("module.mjs", owned), requiredBytes);
      const after = await until(() => readFile(heartbeat, "utf8").then(JSON.parse).catch(() => null), "worker heartbeat unreadable");
      await until(async () => {
        const beat = await readFile(heartbeat, "utf8").then(JSON.parse).catch(() => null);
        return beat?.count > after.count && beat.count > before.count && beat.bytes === requiredBytes;
      }, "escaped worker could no longer read retained checkout bytes");
      assert.match(stderr, /interrupted.*checkout retained/);
      assert.equal((await f.git(["worktree", "list", "--porcelain"])).stdout.match(/^worktree /gm).length, 2);
    } finally {
      // Marker PIDs belong to this fixture. Stop readers before removing any
      // retained tree, including when the old-cleanup mutation fails the test.
      workerPid ||= Number(await readFile(workerMarker, "utf8").catch(() => "0"));
      npmPid ||= Number(await readFile(npmMarker, "utf8").catch(() => "0"));
      if (workerPid) { try { process.kill(workerPid, "SIGKILL"); } catch { /* Already dead. */ } }
      if (npmPid) { try { process.kill(-npmPid, "SIGKILL"); } catch { /* Already dead. */ } }
      validator.kill("SIGKILL");
      await closed;
      if (workerPid) await until(async () => !live((await table()).get(workerPid)), "owned worker teardown failed");
      await removeCheckout(f, owned);
      assert.equal((await f.git(["worktree", "list", "--porcelain"])).stdout.match(/^worktree /gm).length, 1);
    }
  });
