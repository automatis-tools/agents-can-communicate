import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { EXIT } from "../../../tools/agents/lib/errors.mjs";
import { closeAgent, initBus, registerAgent }
  from "../../../tools/agents/lib/identity.mjs";
import { createBusPaths } from "../../../tools/agents/lib/paths.mjs";
import { startWatcher } from "../../../tools/agents/lib/presence.mjs";
import { withRepairMutex } from "../../../tools/agents/lib/repair-mutex.mjs";
import { createBusFixture, createGitWorktreeFixture, pathExists, seedPresence }
  from "./helpers.mjs";

const HEAD = "a".repeat(40);

function registration(overrides = {}) {
  return { agentId: "visual", role: "artist", task: "M2.7",
    worktree: "/tmp/visual-worktree", ownership: ["game/presentation"], ...overrides };
}

function contextFor(fixture, overrides = {}) {
  return { paths: fixture.paths, now: fixture.clock.now, pid: 4242,
    pidIsAlive: pid => pid === 4242,
    gitState: async () => ({ branch: "feature/visual", head: HEAD }),
    releaseOwnedClaims: async () => {}, extendOwnedClaims: async () => {},
    watchDirectory: () => ({ close() {}, once() {} }), output: async () => {},
    ...overrides };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function waitUntil(predicate) {
  for (let index = 0; index < 100_000; index += 1) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail("condition did not become true");
}

test("init rejects a protocol bound to another checkout identity", async t => {
  const fixture = await createGitWorktreeFixture();
  t.after(fixture.cleanup);
  const context = { paths: createBusPaths(fixture.bus),
    now: () => new Date("2026-08-14T18:00:00.000Z") };
  const original = await initBus(context);

  for (const mismatch of [
    { checkout_id: "b".repeat(64) },
    { checkout_root: path.join(fixture.root, "another-checkout") },
  ]) {
    const incompatible = { ...original, ...mismatch };
    await writeFile(context.paths.protocol, `${JSON.stringify(incompatible)}\n`);
    await assert.rejects(initBus(context), error => error.exitCode === EXIT.DATA);
    assert.deepEqual(JSON.parse(await readFile(context.paths.protocol, "utf8")), incompatible);
  }
});

test("open registration requires resume while a closed id starts a new lifecycle", async t => {
  const fixture = await createBusFixture();
  t.after(fixture.cleanup);
  const context = contextFor(fixture, { pidIsAlive: () => false });
  const first = await registerAgent(context, registration());

  await assert.rejects(registerAgent(context, registration({ worktree: "/tmp/replacement" })),
    error => error.exitCode === EXIT.CONFLICT);
  assert.deepEqual(JSON.parse(await readFile(context.paths.registryFile("visual"), "utf8")), first);

  await closeAgent(context, "visual");
  await assert.rejects(registerAgent(context, { ...registration(), resume: true }),
    error => error.exitCode === EXIT.CONFLICT);
  fixture.clock.advance(1_000);
  const reused = await registerAgent(context, registration({ task: "M2.8",
    worktree: "/tmp/reused-worktree" }));
  assert.equal(reused.status, "open");
  assert.equal(reused.task, "M2.8");
  assert.equal(reused.registered_at, "2026-08-14T18:00:01.000Z");
});

test("watcher ownership blocks resume and close even with offline heartbeat", async t => {
  const fixture = await createBusFixture();
  t.after(fixture.cleanup);
  const context = contextFor(fixture);
  await registerAgent(context, registration());
  const watcher = await startWatcher(context, { agentId: "visual" });
  t.after(() => watcher.stop());
  await seedPresence(context, { agentId: "visual", pid: 4242, status: "offline" });

  await assert.rejects(registerAgent(context, { ...registration(), resume: true }),
    error => error.exitCode === EXIT.CONFLICT);
  await assert.rejects(closeAgent(context, "visual"),
    error => error.exitCode === EXIT.CONFLICT);

  await watcher.stop();
  assert.equal((await registerAgent(context, { ...registration(), resume: true })).status, "open");
});

test("watcher start rechecks registration after a racing close", async t => {
  const fixture = await createBusFixture();
  t.after(fixture.cleanup);
  const context = contextFor(fixture);
  await registerAgent(context, registration());
  const held = deferred();
  const releaseHolder = deferred();
  const holding = withRepairMutex(context, "watcher", "visual", async () => {
    held.resolve();
    await releaseHolder.promise;
  });
  await held.promise;

  let watcherWaiting = false;
  const allowWatcherRetry = deferred();
  const watcherContext = { ...context, waitRepairMutex: async () => {
    watcherWaiting = true;
    await allowWatcherRetry.promise;
  } };
  const starting = startWatcher(watcherContext, { agentId: "visual" });
  let startupError = null;
  void starting.catch(error => { startupError = error; });
  await waitUntil(() => watcherWaiting || startupError !== null);
  assert.equal(startupError, null, startupError?.stack);
  const closing = closeAgent(context, "visual");
  await new Promise(resolve => setImmediate(resolve));
  releaseHolder.resolve();
  await holding;
  await closing;
  allowWatcherRetry.resolve();

  const result = await starting.then(value => ({ value }), error => ({ error }));
  if (result.value !== undefined) await result.value.stop();
  assert.equal(result.error?.exitCode, EXIT.CONFLICT);
  assert.equal(await pathExists(path.join(context.paths.locks, "watcher-visual.json")), false);
});
