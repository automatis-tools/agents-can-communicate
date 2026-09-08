import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { writeControl } from "../src/managed-runtime/state.mjs";
import { withManagerLock } from "../src/managed-runtime/mutex.mjs";
import { acquireRuntime, listRuntimeHolds } from "../src/managed-runtime/leases.mjs";

const children = new WeakMap();

async function fixture(t) {
  const parent = await realpath(await mkdtemp(path.join(tmpdir(), "acc-manager-leases-")));
  children.set(t, []);
  t.after(async () => {
    for (const proc of children.get(t)) {
      if (proc.exitCode === null && proc.signalCode === null) {
        const exited = once(proc, "exit");
        proc.kill("SIGKILL");
        await exited;
      }
    }
    await rm(parent, { recursive: true, force: true });
  });
  const root = path.join(parent, "manager");
  const active = { version: "0.4.0", root: path.join(root, "generations", "a") };
  const control = { schemaVersion: 1, active, pending: null, phase: "ready", auto: true,
    pin: null, checkedAt: null, home: parent, targets: [], notice: null };
  return { parent, root, control };
}
async function initialize(f) {
  await mkdir(f.control.active.root, { recursive: true });
  await writeControl(f.root, f.control);
}
function child(t, script, root) {
  const state = new URL("../src/managed-runtime/state.mjs", import.meta.url).href;
  const mutex = new URL("../src/managed-runtime/mutex.mjs", import.meta.url).href;
  const leases = new URL("../src/managed-runtime/leases.mjs", import.meta.url).href;
  const code = `import {readControl,writeControl} from ${JSON.stringify(state)};
    import {withManagerLock} from ${JSON.stringify(mutex)};
    import {acquireRuntime,listRuntimeHolds} from ${JSON.stringify(leases)};
    const root=${JSON.stringify(root)}; ${script}`;
  const proc = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let errors = "";
  proc.stderr.on("data", b => { errors += b; });
  const messages = [];
  proc.on("message", message => messages.push(message));
  children.get(t).push(proc);
  return { proc, messages, next: async () => {
    if (messages.length) return messages.shift();
    return Promise.race([once(proc, "message").then(() => messages.shift()),
      once(proc, "exit").then(() => { throw new Error(`child exited: ${errors}`); })]);
  } };
}

test("listing absent holds never creates runtime state", async t => {
  const f = await fixture(t);
  assert.deepEqual(await listRuntimeHolds(f.root), []);
  assert.deepEqual(await readdir(f.parent), []);
});

test("runtime selection persists a regular lease after admission returns", async t => {
  const f = await fixture(t);
  await initialize(f);
  const lease = await acquireRuntime(f.root, { pid: process.pid, kind: "cli" });
  assert.equal(lease.pid, process.pid);
  assert.equal(lease.runtime.version, "0.4.0");
  const files = await readdir(path.join(f.root, "leases"));
  assert.equal(files.length, 1);
  assert.equal((await stat(path.join(f.root, "leases", files[0]))).isFile(), true);
  assert.equal((await listRuntimeHolds(f.root, { pidIsAlive: () => true })).length, 1);
  assert.equal((await listRuntimeHolds(f.root, { pidIsAlive: () => undefined })).length, 1);
  assert.equal((await listRuntimeHolds(f.root, { pidIsAlive: () => false })).length, 0);
});

test("activation phase refuses admission and writes no lease", async t => {
  const f = await fixture(t);
  await initialize(f);
  await writeControl(f.root, { ...f.control, phase: "activating" });
  await assert.rejects(acquireRuntime(f.root, { pid: process.pid, kind: "cli" }), /activat/i);
  assert.deepEqual(await listRuntimeHolds(f.root), []);
});

test("a stopped admitted process holds its runtime until actual OS death", { timeout: 10000 }, async t => {
  const f = await fixture(t);
  await initialize(f);
  const c = child(t, `const lease=await acquireRuntime(root,{pid:process.pid,kind:"mcp"});
    process.send(lease); setInterval(()=>{},1000);`, f.root);
  const lease = await c.next();
  assert.equal(lease.pid, c.proc.pid);
  c.proc.kill("SIGSTOP");
  const second = await acquireRuntime(f.root);
  assert.deepEqual(new Set((await listRuntimeHolds(f.root)).map(hold => hold.token)), new Set([lease.token, second.token]));
  c.proc.kill("SIGKILL");
  await once(c.proc, "exit");
  assert.deepEqual((await listRuntimeHolds(f.root)).map(hold => hold.token), [second.token]);
});

test("competing admission records selected runtime before activation can inspect holds", { timeout: 10000 }, async t => {
  const f = await fixture(t);
  await initialize(f);
  const activator = child(t, `await withManagerLock(root,async()=>{
    process.send("locked"); await new Promise(r=>process.once("message",r));
    const c=await readControl(root); await writeControl(root,{...c,phase:"activating"});
  }); process.send("done");`, f.root);
  assert.equal(await activator.next(), "locked");
  const admission = child(t, `process.send("started");
    try { const lease=await acquireRuntime(root,{pid:process.pid,kind:"cli"}); process.send({lease}); }
    catch(e) { process.send({error:e.message}); }`, f.root);
  assert.equal(await admission.next(), "started");
  activator.proc.send("continue");
  assert.equal(await activator.next(), "done");
  assert.match((await admission.next()).error, /activat/i);
  await writeControl(f.root, f.control);
  const admitted = child(t, `const lease=await acquireRuntime(root,{pid:process.pid,kind:"cli"});
    process.send(lease); setInterval(()=>{},1000);`, f.root);
  const lease = await admitted.next();
  const inspector = child(t, `await withManagerLock(root,async()=>{process.send(await listRuntimeHolds(root));});`, f.root);
  const holds = await inspector.next();
  assert.equal(holds.length, 1);
  assert.equal(holds[0].pid, admitted.proc.pid);
  assert.deepEqual(holds[0].runtime, lease.runtime);
});

test("an activation contender sees the lease when admission releases the lock", { timeout: 10000 }, async t => {
  const f = await fixture(t);
  await initialize(f);
  const inspector = child(t, `const {readdir}=await import("node:fs/promises");
    process.send("watching");
    for(;;) {
      const names=await readdir(root);
      if(names.includes("manager.lock") || names.some(n=>n.startsWith("manager.reclaimed-"))) break;
      await new Promise(r=>setTimeout(r,1));
    }
    await withManagerLock(root,async()=>process.send(await listRuntimeHolds(root)));`, f.root);
  assert.equal(await inspector.next(), "watching");
  const admitted = child(t, `const lease=await acquireRuntime(root,{pid:process.pid,kind:"cli"});
    process.send(lease); setInterval(()=>{},1000);`, f.root);
  const holds = await inspector.next();
  assert.equal(holds.length, 1);
  assert.equal(holds[0].pid, admitted.proc.pid);
  assert.equal(holds[0].runtime.version, "0.4.0");
  assert.equal((await admitted.next()).runtime.version, "0.4.0");
});

test("SIGSTOP and an old owner timestamp never allow manager lock reclamation", { timeout: 10000 }, async t => {
  const f = await fixture(t);
  await initialize(f);
  const holder = child(t, `await withManagerLock(root,async()=>{
    process.send("locked"); await new Promise(()=>{setInterval(()=>{},1000)});
  });`, f.root);
  assert.equal(await holder.next(), "locked");
  holder.proc.kill("SIGSTOP");
  const file = path.join(f.root, "manager.lock", "owner.json");
  const owner = JSON.parse(await readFile(file));
  await writeFile(file, JSON.stringify({ ...owner, acquiredAt: "2000-01-01T00:00:00.000Z" }));
  await assert.rejects(withManagerLock(f.root, () => "unexpected admission", { timeoutMs: 35 }), /held|timeout/i);
  holder.proc.kill("SIGKILL");
  await once(holder.proc, "exit");
  assert.equal(await withManagerLock(f.root, () => "recovered"), "recovered");
});

test("malformed and symlink leases block management instead of disappearing", async t => {
  const f = await fixture(t);
  await initialize(f);
  const lease = await acquireRuntime(f.root, { pid: process.pid, kind: "cli" });
  const file = path.join(f.root, "leases", `${lease.token}.json`);
  await writeFile(file, "null");
  await assert.rejects(listRuntimeHolds(f.root, { pidIsAlive: () => false }), /lease/i);
  await rm(file);
  const outside = path.join(f.parent, "outside.json");
  await writeFile(outside, JSON.stringify(lease));
  await symlink(outside, file);
  await assert.rejects(listRuntimeHolds(f.root), /ELOOP|symbolic|symlink/i);
});


test("sequential child admissions clean dead leases even when automatic updates are off", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  f.control.auto = false;
  await initialize(f);
  for (let i = 0; i < 8; i++) {
    const c = child(t, `process.send(await acquireRuntime(root)); process.disconnect();`, f.root);
    const exited = once(c.proc, "exit");
    const lease = await c.next();
    assert.deepEqual(await exited, [0, null]);
    assert.deepEqual(await readdir(path.join(f.root, "leases")), [`${lease.token}.json`]);
    assert.equal((await readdir(f.root)).filter(name => name.startsWith("manager.reclaimed-")).length, 1);
  }
});

test("admission housekeeping preserves malformed leases without blocking ordinary admission", async t => {
  const f = await fixture(t);
  await initialize(f);
  const directory = path.join(f.root, "leases");
  await mkdir(directory);
  await writeFile(path.join(directory, "broken.json"), "null");
  const lease = await acquireRuntime(f.root);
  assert.equal(lease.runtime.version, "0.4.0");
  assert.equal(await readFile(path.join(directory, "broken.json"), "utf8"), "null");
  await assert.rejects(listRuntimeHolds(f.root), /lease/i);
});

test("a SIGSTOP registered observer retains old fencing through another admission and cannot retire its successor", { timeout: 10000 }, async t => {
  const f = await fixture(t);
  await initialize(f);
  const holder = child(t, `await withManagerLock(root,async()=>{
    process.send("held"); await new Promise(r=>process.once("message",r));
  }); process.send("released"); process.disconnect();`, f.root);
  assert.equal(await holder.next(), "held");
  const old = JSON.parse(await readFile(path.join(f.root, "manager.lock", "owner.json")));
  const observer = child(t, `try {
    await withManagerLock(root,()=>"stole lock",{timeoutMs:1200,pidIsAlive:async pid=>{
      if(pid!==${old.pid}) return true;
      process.send("observed"); await new Promise(r=>process.once("message",r)); return false;
    }}); process.send("unexpected admission");
  } catch(e) { process.send({error:e.message}); } process.disconnect();`, f.root);
  assert.equal(await observer.next(), "observed");
  observer.proc.kill("SIGSTOP");
  const candidate = (await readdir(f.root)).find(name => name.startsWith(`manager.candidate-${observer.proc.pid}-`));
  assert.ok(candidate, "observer must publish a PID-identifiable candidate before probing");
  const holderExit = once(holder.proc, "exit");
  holder.proc.send("release");
  assert.equal(await holder.next(), "released");
  await holderExit;
  const retired = (await readdir(f.root)).find(name => name.startsWith("manager.reclaimed-"));
  const oldFile = path.join(f.root, retired, "owner.json");
  assert.deepEqual(JSON.parse(await readFile(oldFile)), old);
  await withManagerLock(f.root, () => {});
  assert.deepEqual(JSON.parse(await readFile(oldFile)), old);
  await withManagerLock(f.root, async () => {
    const current = await readFile(path.join(f.root, "manager.lock", "owner.json"), "utf8");
    observer.proc.send("resume");
    observer.proc.kill("SIGCONT");
    assert.match((await observer.next()).error, /held|timeout/i);
    assert.equal(await readFile(path.join(f.root, "manager.lock", "owner.json"), "utf8"), current);
  });
  await withManagerLock(f.root, () => {});
  assert.equal((await readdir(f.root)).filter(name => name.startsWith("manager.reclaimed-")).length, 1);
});


test("admission leaves uncertain process leases and corrupt symlinks intact", async t => {
  const f = await fixture(t);
  await initialize(f);
  const lease = await acquireRuntime(f.root, { pid: 123456789 });
  const kill = process.kill;
  t.mock.method(process, "kill", (pid, signal) => {
    if (pid === lease.pid) throw Object.assign(new Error("unknown PID permission"), { code: "EPERM" });
    return kill.call(process, pid, signal);
  });
  await acquireRuntime(f.root);
  const directory = path.join(f.root, "leases");
  assert.ok((await readdir(directory)).includes(`${lease.token}.json`));
  const outside = path.join(f.parent, "outside.json");
  await writeFile(outside, "null");
  await symlink(outside, path.join(directory, "aaa.json"));
  await acquireRuntime(f.root);
  assert.equal(await readFile(outside, "utf8"), "null");
  await assert.rejects(listRuntimeHolds(f.root), /ELOOP|symbolic|symlink/i);
});

test("activation refusal happens before admission lease housekeeping", async t => {
  const f = await fixture(t);
  await initialize(f);
  const lease = await acquireRuntime(f.root, { pid: 123456789 });
  await writeControl(f.root, { ...f.control, phase: "activating" });
  await assert.rejects(acquireRuntime(f.root), /activation/i);
  assert.deepEqual(await readdir(path.join(f.root, "leases")), [`${lease.token}.json`]);
});
