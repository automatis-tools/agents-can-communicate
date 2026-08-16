import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { inspectRepairMutex, repairStaleRepairMutex, withRepairMutex }
  from "../../../tools/agents/lib/repair-mutex.mjs";
import { createBusFixture, pathExists } from "./helpers.mjs";

const DEAD = 999_999;
function deferred() { let resolve;
  const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function owner(context, kind, age, pid = DEAD, agentId = null) {
  return { schema_version: 1, kind, agent_id: agentId, pid,
    token: "11111111-1111-4111-8111-111111111111",
    acquired_at: new Date(context.now().getTime() - age).toISOString() };
}
async function seed(context, name, record, raw = null) {
  const directory = path.join(context.paths.locks, `${name}.lock`);
  await mkdir(directory);
  await writeFile(path.join(directory, "owner.json"), raw ?? `${JSON.stringify(record)}\n`);
  return directory;
}
async function fixtureFor(t) {
  const fixture = await createBusFixture(); t.after(fixture.cleanup);
  let next = 2;
  return { ...fixture, context: { ...fixture.context, pid: 4242,
    pidIsAlive: pid => pid === 4242,
    randomMutexUUID: () => `22222222-2222-4222-8222-${String(next++).padStart(12, "0")}` } };
}

test("repair mutex reports live, young, stale, and corrupt ownership", async t => {
  const { context } = await fixtureFor(t);
  await seed(context, "doctor", owner(context, "doctor", 100_000, 4242));
  await seed(context, "watcher-young", owner(context, "watcher", 60_000, DEAD, "young"));
  await seed(context, "watcher-stale", owner(context, "watcher", 60_001, DEAD, "stale"));
  await seed(context, "watcher-corrupt", null, "{}\n");
  assert.equal((await inspectRepairMutex(context, "doctor")).state, "live");
  assert.equal((await inspectRepairMutex(context, "watcher", "young")).state, "young");
  assert.equal((await inspectRepairMutex(context, "watcher", "stale")).state, "stale");
  assert.equal((await inspectRepairMutex(context, "watcher", "corrupt")).state, "corrupt");
});

test("only a dead watcher mutex older than sixty seconds is atomically quarantined", async t => {
  const { context } = await fixtureFor(t);
  const stale = owner(context, "watcher", 60_001, DEAD, "models");
  const directory = await seed(context, "watcher-models", stale);
  const repairContext = { ...context, renameRepairMutex: async (from, to) => {
    assert.equal((await readdir(context.paths.quarantine))
      .some(name => name.startsWith("mutex-audit-")), true);
    return rename(from, to);
  } };
  assert.equal(await repairStaleRepairMutex(repairContext, "watcher", "models"), true);
  assert.equal(await pathExists(directory), false);
  const quarantine = await readdir(context.paths.quarantine);
  assert.equal(quarantine.some(name => name.startsWith("mutex-audit-")), true);
  const moved = quarantine.find(name => name.startsWith("mutex-stale-"));
  assert.deepEqual(JSON.parse(await readFile(path.join(context.paths.quarantine,
    moved, "owner.json"), "utf8")), stale);
});

test("live, young, and corrupt mutexes are never repaired", async t => {
  const { context } = await fixtureFor(t);
  for (const [agentId, record, raw] of [
    ["live", owner(context, "watcher", 60_001, 4242, "live")],
    ["young", owner(context, "watcher", 60_000, DEAD, "young")],
    ["corrupt", null, "{}\n"],
  ]) {
    const directory = await seed(context, `watcher-${agentId}`, record, raw);
    assert.equal(await repairStaleRepairMutex(context, "watcher", agentId), false);
    assert.equal(await pathExists(directory), true);
  }
});

test("release moves only its generation before allowing a replacement", async t => {
  const { context } = await fixtureFor(t);
  let held;
  const first = withRepairMutex(context, "watcher", "models", async acquired => {
    held = acquired;
    return "done";
  });
  assert.equal(await first, "done");
  const result = await withRepairMutex(context, "watcher", "models", async acquired => acquired);
  assert.notEqual(result.token, held.token);
});

test("two stale repairs cannot move a replacement mutex generation", async t => {
  const { context } = await fixtureFor(t);
  await seed(context, "watcher-models",
    owner(context, "watcher", 60_001, DEAD, "models"));
  const entered = [deferred(), deferred()], proceed = [deferred(), deferred()];
  let calls = 0;
  const racing = { ...context, renameRepairMutex: async (from, to) => {
    const index = calls++; entered[index].resolve(); await proceed[index].promise;
    return rename(from, to);
  } };
  const first = repairStaleRepairMutex(racing, "watcher", "models");
  await entered[0].promise;
  const second = repairStaleRepairMutex(racing, "watcher", "models");
  await entered[1].promise; proceed[0].resolve(); assert.equal(await first, true);
  const replacementHeld = deferred(), releaseReplacement = deferred();
  const replacement = withRepairMutex(context, "watcher", "models", async value => {
    replacementHeld.resolve(value); await releaseReplacement.promise;
  });
  const ownerB = await replacementHeld.promise; proceed[1].resolve();
  assert.equal(await second, false);
  assert.equal((await inspectRepairMutex(context, "watcher", "models")).owner.token,
    ownerB.token);
  releaseReplacement.resolve(); await replacement;
});
