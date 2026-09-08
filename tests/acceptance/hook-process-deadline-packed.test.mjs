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
  assert.equal(stdout, "");
  assert.ok(Buffer.byteLength(stderr) <= 512);
  const binding = await packed.findBinding(sessionId);
  const roster = (await packed.acc(["status"])).participants;
  if (command === "git") {
    assert.ok(elapsedMs < 7_000, `the default 5-second hook budget took ${elapsedMs}ms`);
    assert.match(stderr, /coordination.*unavailable/i);
    assert.equal(binding, null);
    assert.deepEqual(roster, []);
  } else {
    assert.ok(elapsedMs < 4_000, `the 1-second probe cap took ${elapsedMs}ms`);
    assert.ok(binding, "an optional probe timeout prevented advisory participation");
    assert.equal(binding.clientVersion, undefined);
    assert.equal(binding.clientPid, undefined);
    assert.equal(roster.length, 1);
    assert.equal(roster[0].participantId, participantId);
    assert.equal(roster[0].sessionId, binding.accSessionId);
    assert.equal(roster[0].presence, "online");
    const snapshot = (await packed.acc(["sync", "--scope", "full"])).snapshot;
    assert.equal(snapshot.sessions.length, 1);
    assert.equal(snapshot.sessions[0].pid, null);
    assert.equal(snapshot.sessions[0].enforcement, "advisory");
    await packed.acc(["heartbeat", "--session", binding.accSessionId,
      "--generation", binding.generation]);
  }
});
}
