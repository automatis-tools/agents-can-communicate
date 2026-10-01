import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { createPackedAcc } from "../helpers/packed-acc.mjs";

for (const command of ["git", "claude", "ps"]) {
test(`the installed hook bounds its ${command} probe when it ignores SIGTERM`, {
  skip: process.platform === "win32" ? "the owned probe fixture uses a POSIX shell and /bin/sleep" : false,
}, async t => {
  const packed = await createPackedAcc(t);
  const shim = path.join(packed.clientBin, command);
  const pidFile = path.join(packed.root, "owned-probe-pids");
  await writeFile(shim, '#!/bin/sh\nprintf \'%s\\n\' "$$" >> "$ACC_FIXTURE_PROBE_PID"\ntrap \'\' TERM\nexec /bin/sleep 30\n');
  await chmod(shim, 0o755);
  const sessionId = `slow-${command}-native`;
  const participantId = `slow-${command}-writer`;
  const started = performance.now();
  const child = spawn(process.execPath, [packed.hookBin, "claude_code"], {
    cwd: packed.project,
    env: { ...packed.env, ACC_FIXTURE_PROBE_PID: pidFile, ACC_PARTICIPANT: participantId },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "", stderr = "", watchdogFired = false;
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const exited = once(child, "exit");
  const watchdog = setTimeout(() => {
    watchdogFired = true;
    child.kill("SIGKILL");
  }, 8_000);
  let result, elapsedMs, probePids;
  try {
    child.stdin.end(JSON.stringify({ hook_event_name: "SessionStart", session_id: sessionId,
      cwd: packed.project, source: "startup" }));
    result = await exited;
    elapsedMs = performance.now() - started;
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    // The shim execs sleep in the recorded PID. Only fixture-owned processes
    // are killed; an aborted probe may already have exited normally.
    const recorded = await readFile(pidFile, "utf8").catch(error => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    probePids = [...new Set(recorded.trim().split(/\s+/).filter(Boolean).map(Number))];
    for (const pid of probePids) {
      assert.ok(Number.isInteger(pid) && pid > 0, "fixture recorded an invalid probe PID");
      try { process.kill(pid, "SIGKILL"); } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    await rm(shim, { force: true });
  }
  assert.ok(probePids.length > 0, `the stalled ${command} probe never ran`);
  assert.equal(watchdogFired, false, `the hook needed its 8-second watchdog (${elapsedMs}ms)`);
  assert.deepEqual(result, [0, null]);
  assert.ok(Buffer.byteLength(stderr) <= 512);
  const binding = await packed.findBinding(sessionId);
  const roster = (await packed.acc(["status"])).participants;
  if (command === "git") {
    assert.equal(stdout, "");
    assert.ok(elapsedMs < 7_000, `the default 5-second hook budget took ${elapsedMs}ms`);
    assert.match(stderr, /coordination.*unavailable/i);
    assert.equal(binding, null);
    assert.deepEqual(roster, []);
  } else {
    assert.ok(elapsedMs < 4_000, `the 1-second probe cap took ${elapsedMs}ms`);
    assert.ok(binding, "an optional probe timeout prevented advisory participation");
    assert.notEqual(stdout, "", "optional probe timeout must retain restored owner context");
    const context = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(context.hookEventName, "SessionStart");
    assert.match(context.additionalContext,
      new RegExp(`^ACC CLI \\(append\\): --session ${binding.accSessionId} --generation ${binding.generation} --cwd `));
    assert.equal(binding.clientVersion, undefined);
    assert.equal(binding.clientPid, undefined);
    assert.equal(roster.length, 1);
    assert.equal(roster[0].participantId, participantId);
    assert.equal(roster[0].sessionId, binding.accSessionId);
    assert.equal(roster[0].presence, "online");
    const snapshot = (await packed.acc(["sync", "--scope", "full"])).snapshot;
    assert.equal(snapshot.sessions.length, 1);
    assert.equal(snapshot.sessions[0].pid, null);
    // The probe timed out, so the binding records no version - and the session
    // is still this client, running the guard hooks the installer wrote. The
    // capabilities its captures prove therefore stand, enforcement included.
    assert.equal(snapshot.sessions[0].enforcement, "guarded");
    await packed.acc(["heartbeat", "--session", binding.accSessionId,
      "--generation", binding.generation]);
  }
});
}

// The Windows side of the same bound. npm installs a client as a `.cmd`, which
// cmd.exe runs by starting node as a child of its own; a version probe that hangs
// there outlived its limit while execFile waited for that child's pipes.
test("windows: the installed hook bounds a hung claude.cmd version probe",
  { skip: process.platform !== "win32" && "npm installs a client as a .cmd only on Windows" },
  async t => {
    const { writeFakeClient } = await import("../helpers/fake-client.mjs");
    const packed = await createPackedAcc(t);
    const pidFile = path.join(packed.root, "owned-probe-pids");
    await writeFakeClient(packed.clientBin, "claude", { script:
      `import { appendFileSync } from "node:fs";\n`
      + `appendFileSync(${JSON.stringify(pidFile)}, process.pid + "\\n");\n`
      + "setTimeout(() => {}, 30000);\n" });
    const sessionId = "hung-claude-cmd";
    const started = performance.now();
    const child = spawn(process.execPath, [packed.hookBin, "claude_code"], {
      cwd: packed.project, env: { ...packed.env, ACC_PARTICIPANT: "hung-cmd-writer" },
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    let stdout = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.resume();
    const exited = once(child, "exit");
    const watchdog = setTimeout(() => child.kill(), 15_000);
    child.stdin.end(JSON.stringify({ hook_event_name: "SessionStart", session_id: sessionId,
      cwd: packed.project, source: "startup" }));
    const result = await exited;
    const elapsedMs = performance.now() - started;
    clearTimeout(watchdog);

    const pids = (await readFile(pidFile, "utf8").catch(() => "")).trim().split(/\s+/)
      .filter(Boolean).map(Number);
    const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (const deadline = Date.now() + 5_000; pids.some(alive) && Date.now() < deadline;) {
      await new Promise(resolve => { setTimeout(resolve, 100); });
    }
    const survivors = pids.filter(alive);
    for (const pid of survivors) process.kill(pid);

    assert.ok(pids.length > 0, "the hung claude.cmd probe never ran");
    assert.deepEqual(survivors, [], "the node claude.cmd started outlived the hook");
    assert.deepEqual(result, [0, null]);
    assert.ok(elapsedMs < 7_000, `the five-second hook budget took ${elapsedMs}ms`);
    const binding = await packed.findBinding(sessionId);
    assert.ok(binding, "a hung optional probe prevented the session from attaching");
    assert.equal(binding.clientVersion, undefined);
    assert.notEqual(stdout, "", "the attached session's owner context is missing");
  });
