import assert from "node:assert/strict";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { createPackedAcc } from "../helpers/packed-acc.mjs";

// Installed hook processes and filesystem state, not model/capability evidence.
// The in-process cases additionally control a slow client-version probe.
test("installed lifecycle hooks keep one ACC owner per native session", async t => {
  const packed = await createPackedAcc(t);
  const load = (name, file = "index.mjs") => import(pathToFileURL(path.join(packed.installed,
    "node_modules", "@agents-can-communicate", name, "src", file)).href);
  const { runHook } = await load("hook-runner", "runner.mjs");
  const { loadSessionBinding } = await load("adapter-sdk");
  const adapter = { id: "fixture", normalizeHook: payload => payload,
    capabilities: {}, client: { command: "fixture", versionArgs: ["--version"] } };
  const start = (sessionId, extra = {}) => runHook({ adapterId: adapter.id,
    adapters: { [adapter.id]: adapter }, dataHome: packed.dataHome, env: packed.env,
    payload: { kind: "sessionStart", sessionId, cwd: packed.project },
    readProcessTable: async () => new Map(),
    probeClientVersion: async () => { await delay(100); return null; }, ...extra });

  await t.test("concurrent first starts and reattachments share a usable binding", async () => {
    const starts = await Promise.all(Array.from({ length: 3 }, () => start("same-native")));
    for (const result of starts) assert.equal(result.failed, undefined, result.reason);
    assert.equal(new Set(starts.map(r => r.accSessionId)).size, 1);
    assert.equal(new Set(starts.map(r => r.generation)).size, 1);
    const [original] = starts;
    const status = await packed.acc(["status"]);
    assert.equal(status.participants.length, 1);
    const binding = await loadSessionBinding({ runtimeDir: original.service.store.root,
      harnessSessionId: "same-native" });
    assert.equal(binding.accSessionId, original.accSessionId);
    assert.equal(binding.generation, original.generation);
    await packed.acc(["heartbeat", "--session", binding.accSessionId,
      "--generation", binding.generation]);
    const resumed = await Promise.all([start("same-native"), start("same-native")]);
    for (const result of resumed) {
      assert.equal(result.failed, undefined, result.reason);
      assert.equal(result.accSessionId, binding.accSessionId);
      assert.equal(result.generation, binding.generation);
    }
  });

  await t.test("independent native IDs are not blocked by another lifecycle probe", async () => {
    let entered, release;
    const reached = new Promise(resolve => { entered = resolve; });
    const blocked = new Promise(resolve => { release = resolve; });
    const slow = start("slow-native", { probeClientVersion: async () => {
      entered(); await blocked; return null;
    } });
    await reached;
    try {
      const independent = await start("independent-native");
      assert.equal(independent.failed, undefined, independent.reason);
      assert.notEqual(independent.accSessionId, undefined);
    } finally { release(); await slow; }
  });

  await t.test("an end queued behind the first start closes the session it creates", async () => {
    let entered, release;
    const reached = new Promise(resolve => { entered = resolve; });
    const blocked = new Promise(resolve => { release = resolve; });
    const starting = start("ending-native", { probeClientVersion: async () => {
      entered(); await blocked; return null;
    } });
    await reached;
    const ending = start("ending-native", { payload: { kind: "sessionEnd",
      sessionId: "ending-native", cwd: packed.project } });
    // Let an unlocked end finish its no-op while the first start is still paused.
    try { await Promise.race([ending, delay(100)]); } finally { release(); }
    const [opened, ended] = await Promise.all([starting, ending]);
    assert.equal(ended.failed, undefined, ended.reason);
    assert.equal(await loadSessionBinding({ runtimeDir: opened.service.store.root,
      harnessSessionId: "ending-native" }), null);
    assert.equal((await packed.acc(["status"])).participants
      .some(p => p.sessionId === opened.accSessionId && p.presence !== "offline"), false);
  });

  await t.test("an expired lifecycle waiter cannot probe or publish after its turn returns", async () => {
    let entered, release, expiredProbes = 0;
    const reached = new Promise(resolve => { entered = resolve; });
    const blocked = new Promise(resolve => { release = resolve; });
    const starting = start("deadline-native", { probeClientVersion: async () => {
      entered(); await blocked; return null;
    } });
    await reached;
    let expired;
    try {
      expired = await start("deadline-native", { budgetMs: 30,
        probeClientVersion: async () => { expiredProbes += 1; return null; } });
    } finally { release(); }
    const original = await starting;
    assert.equal(expired.exitCode, 0);
    assert.equal(expired.failed === true || expired.timedOut === true, true);
    const retry = await start("deadline-native");
    assert.equal(retry.failed, undefined, retry.reason);
    assert.equal(retry.accSessionId, original.accSessionId);
    assert.equal(expiredProbes, 0);
  });

  await t.test("a corrupt binding fails open without opening another session", async () => {
    const original = await start("corrupt-native");
    assert.equal(original.failed, undefined, original.reason);
    const bindings = path.join(original.service.store.root, "bindings");
    const { createHash } = await import("node:crypto");
    const name = `${createHash("sha256").update("corrupt-native").digest("hex").slice(0, 32)}.json`;
    const before = (await packed.acc(["status"])).participants;
    await writeFile(path.join(bindings, name), "{broken");
    const result = await start("corrupt-native");
    assert.equal(result.exitCode, 0);
    assert.equal(result.decision, "allow");
    assert.equal(result.failed, true);
    assert.match(result.reason, /binding.*valid JSON/);
    assert.deepEqual((await packed.acc(["status"])).participants, before);
  });

  await t.test("a failed lifecycle probe releases its lock for a later retry", async () => {
    const failed = await start("retry-native", {
      probeClientVersion: async () => { throw new Error("fixture probe unavailable"); } });
    assert.equal(failed.failed, true);
    assert.equal(failed.exitCode, 0);
    const retried = await start("retry-native");
    assert.equal(retried.failed, undefined, retried.reason);
    await packed.acc(["heartbeat", "--session", retried.accSessionId,
      "--generation", retried.generation]);
  });

  await t.test("separate executable starts leave one session and detach it cleanly", async () => {
    const payload = { hook_event_name: "SessionStart", session_id: "native-process",
      cwd: packed.project, source: "startup" };
    await Promise.all(Array.from({ length: 4 }, () => packed.hook("claude_code", payload,
      { ACC_PARTICIPANT: "process-writer" })));
    const rows = (await packed.acc(["status"])).participants
      .filter(p => p.participantId === "process-writer");
    assert.equal(rows.length, 1);
    const binding = await packed.findBinding("native-process");
    assert.equal(binding.accSessionId, rows[0].sessionId);
    await packed.acc(["heartbeat", "--session", binding.accSessionId,
      "--generation", binding.generation]);
    await packed.hook("claude_code", { ...payload, hook_event_name: "SessionEnd" });
    assert.equal(await packed.findBinding("native-process"), null);
    assert.equal((await packed.acc(["status"])).participants
      .filter(p => p.participantId === "process-writer" && p.presence !== "offline").length, 0);
    assert.deepEqual(await readdir(packed.project), []);
  });
});
