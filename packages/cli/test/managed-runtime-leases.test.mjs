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
  assert.equal((await listRuntimeHolds(f.root)).length, 1);
  c.proc.kill("SIGKILL");
  await once(c.proc, "exit");
  assert.equal((await listRuntimeHolds(f.root)).length, 0);
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
