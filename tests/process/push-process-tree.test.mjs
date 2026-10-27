// The original PGID-only cancellation misses runTestBatch's detached group.
// Use the unchanged real helper and one hanging file, never the full ACC suite.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { stopPushProcessTree } from "../../scripts/push-process-tree.mjs";
import { fixture } from "../helpers/push-fixture.mjs";

const url = file => pathToFileURL(path.resolve(import.meta.dirname, "../../scripts", file)).href;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("interruption terminates the real detached batch and worker before checkout cleanup",
  { timeout: 20000, skip: process.platform === "win32" }, async t => {
    const f = await fixture(t);
    const workerMarker = path.join(f.base, "worker");
    const batchMarker = path.join(f.base, "batch");
    const runnerMarker = path.join(f.base, "runner");
    await writeFile(path.join(f.root, "target.test.mjs"), `import {writeFileSync} from 'node:fs';
      writeFileSync(${JSON.stringify(workerMarker)}, String(process.pid)); setInterval(()=>{},1000);`);
    const oid = await f.commit("one hanging batch worker");
    const runnerSource = `import {runTestBatch} from ${JSON.stringify(url("test-process.mjs"))};
      import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs';
      writeFileSync(${JSON.stringify(runnerMarker)}, String(process.pid));
      await runTestBatch(['target.test.mjs'], {cwd:process.cwd(),env:process.env,
        spawnChild:(...args)=>{const batch=spawn(...args); writeFileSync(${JSON.stringify(batchMarker)},String(batch.pid)); return batch;}});`;
    const source = `import {withPushCheckout,runPushCommand} from ${JSON.stringify(url("push-targets.mjs"))};
      try { await withPushCheckout(process.cwd(), {commit:${JSON.stringify(oid)},checkout:'isolated'}, async(cwd,signal)=>{
        console.log('READY '+cwd); await runPushCommand(process.execPath,['--input-type=module','-e',${JSON.stringify(runnerSource)}],{cwd,signal});
      }); } catch(error) {console.error(error.message); process.exitCode=1;}`;
    const validator = spawn(process.execPath, ["--input-type=module", "-e", source], { cwd: f.root, env: f.env });
    let stdout = "";
    let stderr = "";
    validator.stdout.on("data", data => { stdout += data; });
    validator.stderr.on("data", data => { stderr += data; });
    const closed = new Promise(resolve => validator.once("close", resolve));
    let pids = [];
    let owned;
    let monitor;
    let removedWhileAlive = false;
    try {
      const deadline = Date.now() + 10000;
      while (!await f.exists(workerMarker)) {
        assert.ok(Date.now() < deadline, `worker never started: ${stderr}`);
        await delay(10);
      }
      pids = await Promise.all([runnerMarker, batchMarker, workerMarker].map(async file => Number(await readFile(file, "utf8"))));
      assert.ok(pids.every(alive), "actual batch topology was not live");
      owned = stdout.match(/READY (.+)/)[1].trim();
      monitor = setInterval(async () => {
        if (!await f.exists(owned) && pids.some(alive)) removedWhileAlive = true;
      }, 5);
      validator.kill("SIGTERM");
      assert.notEqual(await closed, 0);
      assert.match(stderr, /interrupted/);
      assert.ok(pids.every(pid => !alive(pid)), "detached batch or worker survived cancellation");
      assert.equal(removedWhileAlive, false, "owned checkout disappeared under actual batch workers");
      assert.equal(await f.exists(owned), false);
      assert.equal((await f.git(["worktree", "list", "--porcelain"])).stdout.match(/^worktree /gm).length, 1);
    } finally {
      clearInterval(monitor);
      for (const file of [runnerMarker, batchMarker, workerMarker]) {
        const pid = Number(await readFile(file, "utf8").catch(() => "0"));
        if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* Already dead. */ } }
      }
      validator.kill("SIGKILL");
      await closed;
      if (owned && await f.exists(owned)) {
        await f.git(["worktree", "remove", "--force", owned]);
        await import("node:fs/promises").then(fs => fs.rm(path.dirname(owned), { recursive: true, force: true }));
      }
    }
  });


const row = (pid, parent, group, state = "T") => ({ pid, parent, group, state });
const table = (...rows) => new Map(rows.map(value => [value.pid, value]));

// Explicit process-table controls cover OS failures and topology races that a
// portable native timing fixture cannot schedule deterministically.
for (const fault of ["query-failed", "missing-root", "zombie-parent", "reparented", "vanished", "never-stops", "never-dies", "stop-denied"]) {
  test(`uncertain POSIX ${fault} retains checkout and never signals peers`, async () => {
    const signals = [];
    let reads = 0;
    const observed = table(row(100, 1, 100), row(101, 100, 101, "R"), row(900, 1, 900));
    const result = await stopPushProcessTree(100, {
      snapshot: async () => {
        reads++;
        if (fault === "query-failed") throw Error("ps unavailable");
        if (fault === "missing-root") return table(row(900, 1, 900));
        if (fault === "zombie-parent") return table(row(100, 1, 100), row(101, 100, 101, "Z"));
        if (fault === "reparented" && reads > 1) return table(row(100, 1, 100), row(101, 1, 101), row(900, 1, 900));
        if (fault === "vanished" && reads > 1) return table(row(100, 1, 100), row(900, 1, 900));
        if (fault === "never-dies") return table(row(100, 1, 100), row(101, 100, 101), row(900, 1, 900));
        return observed;
      },
      kill: (pid, signal) => {
        signals.push([pid, signal]);
        if (fault === "stop-denied") throw Object.assign(Error("denied"), { code: "EPERM" });
      }, wait: async () => {},
    });
    assert.equal(result?.code, "PUSH_TERMINATION_UNCONFIRMED");
    assert.ok(signals.every(([pid]) => [-100, 100, 101].includes(pid)), "unowned PID or group was signalled");
  });
}

test("a newly observed detached worker is frozen before any owned termination", async () => {
  const signals = [];
  const snapshots = [
    table(row(100, 1, 100), row(101, 100, 101, "R"), row(900, 1, 900)),
    table(row(100, 1, 100), row(101, 100, 101), row(102, 101, 102, "R"), row(900, 1, 900)),
    table(row(100, 1, 100), row(101, 100, 101), row(102, 101, 102), row(900, 1, 900)),
    table(row(900, 1, 900)),
  ];
  const result = await stopPushProcessTree(100, {
    snapshot: async () => snapshots.shift(), kill: (pid, signal) => signals.push([pid, signal]), wait: async () => {},
  });
  assert.equal(result, null);
  const firstKill = signals.findIndex(([, signal]) => signal === "SIGKILL");
  assert.ok(signals.findIndex(([pid, signal]) => pid === 102 && signal === "SIGSTOP") < firstKill);
  assert.ok([100, 101, 102].every(pid => signals.some(([target, signal]) => target === pid && signal === "SIGKILL")));
  assert.ok(signals.every(([pid]) => [-100, 100, 101, 102].includes(pid)));
});

test("a process identity change never causes a stale PID kill", async () => {
  const signals = [];
  let reads = 0;
  const result = await stopPushProcessTree(100, {
    snapshot: async () => ++reads === 1
      ? table(row(100, 1, 100), row(101, 100, 101, "R"))
      : table(row(100, 1, 100), row(101, 900, 900, "R"), row(900, 1, 900)),
    kill: (pid, signal) => signals.push([pid, signal]), wait: async () => {},
  });
  assert.equal(result?.code, "PUSH_TERMINATION_UNCONFIRMED");
  assert.equal(signals.some(([pid, signal]) => pid === 101 && signal === "SIGKILL"), false,
    "uncertain ownership triggered a stale PID kill");
});

test("reparented members of the original owned group cannot remain suspended after cleanup", async () => {
  const signals = [];
  let reads = 0;
  const result = await stopPushProcessTree(100, {
    snapshot: async () => ++reads === 1
      ? table(row(100, 1, 100), row(101, 1, 100), row(900, 1, 900)) : table(row(900, 1, 900)),
    kill: (pid, signal) => signals.push([pid, signal]), wait: async () => {},
  });
  assert.equal(result, null);
  assert.ok(signals.some(([pid, signal]) => pid === 101 && signal === "SIGKILL"), "owned group member escaped discovery");
  assert.ok(signals.every(([pid]) => [-100, 100, 101].includes(pid)));
});


test("unrelated Linux PGID-zero rows do not prevent confirmed owned cancellation",
  { timeout: 10000, skip: process.platform === "win32" }, async t => {
    const f = await fixture(t);
    const bin = path.join(f.base, "bin");
    await mkdir(bin);
    // Containers hide host kernel threads. Preserve the real process table and
    // append one explicit kernel-style row to exercise the same parser boundary.
    await writeFile(path.join(bin, "ps"), "#!/bin/sh\n/bin/ps \"$@\"\nprintf '2147483000 2 0 S\\n'\n", { mode: 0o755 });
    const child = spawn(process.execPath, ["-e", "console.log('ready'); setInterval(()=>{},1000)"],
      { detached: true, env: f.env, stdio: ["ignore", "pipe", "pipe"] });
    const closed = new Promise(resolve => child.once("close", resolve));
    await new Promise(resolve => child.stdout.once("data", resolve));
    const previousPath = process.env.PATH;
    const signals = [];
    try {
      process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
      const result = await stopPushProcessTree(child.pid, { kill: (pid, signal) => {
        signals.push([pid, signal]); return process.kill(pid, signal);
      } });
      assert.equal(result, null, "an unrelated PGID-zero row refused confirmed owned termination");
      await closed;
      assert.equal(alive(child.pid), false);
      assert.ok(signals.every(([pid]) => pid === child.pid || pid === -child.pid), "system or peer PID was signalled");
    } finally {
      process.env.PATH = previousPath;
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already terminated. */ }
      await closed;
    }
  });

for (const position of ["root", "child"]) {
  test(`a zero process group in the owned ${position} remains unconfirmed`, async () => {
    const signals = [];
    let reads = 0;
    const result = await stopPushProcessTree(100, {
      snapshot: async () => ++reads === 1
        ? table(row(100, 1, position === "root" ? 0 : 100), row(101, 100, position === "child" ? 0 : 101))
        : table(),
      kill: (pid, signal) => signals.push([pid, signal]), wait: async () => {},
    });
    assert.equal(result?.code, "PUSH_TERMINATION_UNCONFIRMED");
    assert.deepEqual(signals, [[-100, "SIGSTOP"]], "uncertain owned group was signalled after discovery");
  });
}
