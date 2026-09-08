import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { createPackedAcc } from "../helpers/packed-acc.mjs";

// Pause only an awaited boundary; actual installed hooks, bindings and storage
// still run. Resuming after the timeout exposes background side effects.
test("installed hooks bound the whole invocation and cancel undecided writes", async t => {
  const packed = await createPackedAcc(t);
  let boundary, reached, release;
  let paused = Promise.resolve();
  globalThis.accDeadlineCheckpoint = async point => {
    if (point !== boundary) return;
    boundary = null;
    reached();
    await paused;
  };
  const instrumentation = registerHooks({ load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    const seams = url.endsWith("/hook-runner/src/runner.mjs") ? [
      ["    const handler = HANDLERS[event.kind];", "context"],
      ["    const status = await context.service.collectStatus({", "status"],
      ["    const session = await context.service.openSession({", "core-open"],
    ] : url.endsWith("/adapter-sdk/src/session-binding.mjs") ? [
      ['  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\\n`, "utf8");', "binding"],
    ] : [];
    if (seams.length === 0) return result;
    let source = Buffer.from(result.source).toString();
    for (const [needle, point] of seams) {
      assert.equal(source.split(needle).length, 2, `one installed ${point} boundary`);
      const checkpoint = `await globalThis.accDeadlineCheckpoint(${JSON.stringify(point)});`;
      source = source.replace(needle, point === "binding" ? `${needle}\n  ${checkpoint}`
        : `${checkpoint}\n${needle}`);
    }
    return { ...result, source };
  } });
  t.after(() => { instrumentation.deregister(); delete globalThis.accDeadlineCheckpoint; });
  const load = (name, file = "index.mjs") => import(pathToFileURL(path.join(packed.installed,
    "node_modules", "@agents-can-communicate", name, "src", file)).href);
  const { runHook } = await load("hook-runner", "runner.mjs");
  const { completeHookOutput } = await import(pathToFileURL(packed.hookBin).href);
  const { withSessionLifecycle } = await load("hook-runner", "session-lifecycle.mjs");
  const { storeSessionBinding, clearSessionBinding, loadSessionBinding } = await load("adapter-sdk");
  const adapter = { id: "fixture", normalizeHook: payload => payload,
    capabilities: {}, client: { command: "missing-fixture" } };
  const clock = { now: () => new Date().toISOString() };
  const invoke = (id, extra = {}) => runHook({ adapterId: adapter.id,
    adapters: { fixture: adapter }, dataHome: packed.dataHome, env: packed.env,
    payload: { kind: "sessionStart", sessionId: id, cwd: packed.project },
    readProcessTable: async () => new Map(), probeClientVersion: async () => null,
    budgetMs: 1000, ...extra });
  const runtimeRoot = async () => path.join(packed.dataHome, "acc", "workspaces",
    (await readdir(path.join(packed.dataHome, "acc", "workspaces")))[0]);
  const drain = async id => withSessionLifecycle({ root: await runtimeRoot(), sessionId: id,
    clock, deadlineAt: Date.now() + 5000 }, async () => {});
  const hold = point => {
    boundary = point;
    const entered = new Promise(resolve => { reached = resolve; });
    paused = new Promise(resolve => { release = resolve; });
    return entered;
  };
  t.after(() => release?.());

  await t.test("a delayed version probe cannot create an owner after returning timeout", async () => {
    const id = "late-probe";
    const entered = hold("probe");
    const running = invoke(id, { probeClientVersion: async () => {
      await globalThis.accDeadlineCheckpoint("probe"); return null;
    } });
    await entered;
    const result = await running;
    const before = (await packed.acc(["status"])).participants;
    release();
    await drain(id);
    assert.equal(result.timedOut, true);
    const diagnostics = [];
    await completeHookOutput(result, {
      stdout: { write(_bytes, callback) { callback?.(); } },
      stderr: { write(bytes, callback) { diagnostics.push(bytes); callback?.(); } },
    });
    assert.match(diagnostics.join(""), /coordination.*unavailable/i);
    assert.deepEqual((await packed.acc(["status"])).participants, before);
    assert.equal(await packed.findBinding(id), null);
  });

  for (const point of ["normalize", "context", "status"]) {
    await t.test(`${point} work cannot keep the caller past its total budget`, async () => {
      const id = `late-${point}`;
      const entered = hold(point);
      const running = invoke(id, point === "normalize" ? { adapters: { fixture: {
        ...adapter, normalizeHook: async payload => {
          await globalThis.accDeadlineCheckpoint("normalize"); return payload;
        } } } } : { payload: { kind: "unknown", sessionId: id, cwd: packed.project } });
      await entered;
      let result;
      try {
        result = await Promise.race([running, delay(1500).then(() => null)]);
      } finally { release(); await running; }
      assert.notEqual(result, null, `${point} escaped the invocation deadline`);
      assert.equal(result.timedOut, true);
      assert.equal(result.exitCode, 0);
      assert.equal(result.decision, "allow");
      assert.equal(result.stdout, "");
    });
  }

  await t.test("a binding prepared before timeout cannot publish afterward", async () => {
    const id = "late-binding";
    const entered = hold("binding");
    const running = invoke(id);
    await entered;
    const result = await running;
    const before = (await packed.acc(["status"])).participants;
    release();
    await drain(id);
    assert.equal(result.timedOut, true);
    assert.equal(await packed.findBinding(id), null);
    assert.deepEqual((await packed.acc(["status"])).participants, before);
    // This unblocked recovery is a positive control, not another forced expiry.
    const retry = await invoke(id, { budgetMs: 5_000 });
    assert.notEqual(retry.timedOut, true, "recovery exhausted its normal hook budget");
    assert.equal(retry.failed, undefined, retry.reason);
    await packed.acc(["heartbeat", "--session", retry.accSessionId, "--generation", retry.generation]);
  });

  await t.test("expiry after pre-binding cannot create its session and retry uses a fresh pair", async () => {
    const id = "late-core-open";
    const entered = hold("core-open");
    const running = invoke(id);
    await entered;
    const pending = await packed.findBinding(id);
    assert.ok(pending?.generation);
    const result = await running;
    const before = (await packed.acc(["status"])).participants;
    release();
    await drain(id);
    assert.equal(result.timedOut, true);
    assert.deepEqual((await packed.acc(["status"])).participants, before);
    assert.deepEqual(await packed.findBinding(id), pending);
    const retry = await invoke(id, { budgetMs: 5_000 });
    assert.notEqual(retry.timedOut, true, "recovery exhausted its normal hook budget");
    assert.equal(retry.failed, undefined, retry.reason);
    assert.notEqual(retry.generation, pending.generation);
    await packed.acc(["heartbeat", "--session", retry.accSessionId, "--generation", retry.generation]);
  });

  await t.test("expired binding replacement and removal preserve the current owner", async () => {
    const root = await runtimeRoot();
    const original = { runtimeDir: root, harnessSessionId: "binding-deadline",
      accSessionId: "session_original", generation: "generation_original" };
    await storeSessionBinding(original);
    await assert.rejects(storeSessionBinding({ ...original, generation: "generation_late",
      deadlineAt: Date.now() - 1 }), /deadline/);
    await assert.rejects(clearSessionBinding({ runtimeDir: root,
      harnessSessionId: original.harnessSessionId, deadlineAt: Date.now() - 1 }), /deadline/);
    assert.deepEqual(await loadSessionBinding(original), {
      accSessionId: original.accSessionId, generation: original.generation });
  });
});
