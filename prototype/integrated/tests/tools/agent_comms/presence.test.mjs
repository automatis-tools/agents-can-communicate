import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { EXIT } from "../../../tools/agents/lib/errors.mjs";
import { listInbox, markSeen, sendMessage } from "../../../tools/agents/lib/messages.mjs";
import { presenceState, startWatcher, waitForMessage } from "../../../tools/agents/lib/presence.mjs";
import { validatePresence } from "../../../tools/agents/lib/schema.mjs";
import { createMessagingFixture, messageRequest, pathExists } from "./helpers.mjs";
const ownerFile = context => path.join(context.paths.locks, "watcher-models.json");
const watch = context => startWatcher(context, { agentId: "models" });
const presenceAt = (heartbeatAt, pid = 42, status = "online") => ({
  schema_version: 1, agent_id: "models", pid, status, heartbeat_at: heartbeatAt });
const instant = seconds => new Date(
  `2026-08-14T18:00:${String(seconds).padStart(2, "0")}.000Z`);
function createScheduler(clock, { eagerZeroTimeout = false } = {}) {
  let current = 0, nextId = 1;
  const tasks = new Map();
  const schedule = (callback, delay, interval) => {
    const id = nextId++; tasks.set(id, { callback, due: current + delay, interval });
    return id;
  };
  return {
    setInterval: (callback, delay) => schedule(callback, delay, delay),
    clearInterval: id => tasks.delete(id),
    setTimeout: (callback, delay) => eagerZeroTimeout && delay === 0
      ? (callback(), 0) : schedule(callback, delay, null),
    clearTimeout: id => tasks.delete(id),
    size: () => tasks.size,
    advance: async milliseconds => {
      const target = current + milliseconds;
      while (true) {
        const pending = [...tasks.entries()].filter(([, task]) => task.due <= target)
          .sort((left, right) => left[1].due - right[1].due)[0];
        if (pending === undefined) break;
        const [id, task] = pending;
        clock.advance(task.due - current);
        current = task.due;
        if (task.interval === null) tasks.delete(id); else task.due += task.interval;
        await task.callback();
      }
      clock.advance(target - current);
      current = target;
    },
  };
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function createWatchControl() {
  const watchers = new Set();
  return {
    watchDirectory: (_directory, callback) => {
      const watcher = { callback, closed: false };
      watchers.add(watcher);
      return { close: () => { watcher.closed = true; } };
    },
    active: () => [...watchers].filter(watcher => !watcher.closed).length,
    emit: () => Promise.all([...watchers].filter(watcher => !watcher.closed)
      .map(watcher => watcher.callback("rename", "message.json"))),
  };
}
async function watcherFixture(t, overrides = {}) {
  const fixture = await createMessagingFixture(t);
  const scheduler = createScheduler(fixture.clock), watchControl = createWatchControl();
  const events = [], extensions = [];
  const livePids = new Set([4242]);
  const context = {
    ...fixture.context,
    pid: 4242, scheduler,
    pidIsAlive: pid => livePids.has(pid),
    watchDirectory: watchControl.watchDirectory,
    output: async event => { events.push(event); },
    extendOwnedClaims: async agentId => { extensions.push(agentId); },
    ...overrides,
  };
  return { ...fixture, context, scheduler, watchControl, events, extensions, livePids };
}
async function readPresence(context, agentId = "models") {
  const source = await readFile(context.paths.presenceFile(agentId), "utf8");
  return validatePresence(JSON.parse(source));
}
async function waitUntil(predicate) {
  for (let index = 0; index < 1_000; index += 1)
    if (predicate()) return; else await new Promise(resolve => setImmediate(resolve));
  assert.fail("condition did not become true");
}
test("heartbeat transitions online to stale to offline", () => {
  const record = presenceAt("2026-08-14T18:00:00.000Z");
  assert.equal(presenceState(record, instant(44), () => true), "online");
  assert.equal(presenceState(record, instant(46), () => true), "stale");
  assert.equal(presenceState(record, instant(46), () => false), "offline");
  assert.equal(presenceState({ ...record, status: "offline" }, instant(1), () => true),
    "offline");
});
test("concurrent watcher starts acquire one atomic owner", async t => {
  const fixture = await watcherFixture(t);
  fixture.livePids.add(4343);
  const attempts = await Promise.allSettled([
    watch(fixture.context), watch({ ...fixture.context, pid: 4343 }),
  ]);
  const started = attempts.filter(attempt => attempt.status === "fulfilled");
  const rejected = attempts.filter(attempt => attempt.status === "rejected");
  assert.equal(started.length, 1); assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.exitCode, EXIT.CONFLICT);
  const owner = JSON.parse(await readFile(ownerFile(fixture.context), "utf8"));
  assert.deepEqual(Object.keys(owner).sort(), ["acquired_at", "agent_id", "pid",
    "schema_version", "token"]);
  await started[0].value.stop();
});
test("a former owner token cannot heartbeat or stop over its successor", async t => {
  const fixture = await watcherFixture(t);
  const first = await watch(fixture.context);
  const owner = JSON.parse(await readFile(ownerFile(fixture.context), "utf8"));
  const successor = { ...owner, pid: 4343,
    token: "11111111-1111-4111-8111-111111111111" };
  await writeFile(ownerFile(fixture.context), `${JSON.stringify(successor)}\n`);
  await writeFile(fixture.context.paths.presenceFile("models"),
    `${JSON.stringify(presenceAt("2026-08-14T18:00:00.000Z", 4343))}\n`);
  const lostDone = first.done.catch(error => error);
  await fixture.scheduler.advance(15_000);
  assert.equal((await lostDone).exitCode, EXIT.CONFLICT);
  assert.deepEqual(JSON.parse(await readFile(ownerFile(fixture.context), "utf8")), successor);
  assert.equal((await readPresence(fixture.context)).pid, 4343);
});
test("a dead owner blocks all contenders and remains unchanged", async t => {
  const fixture = await watcherFixture(t);
  const incumbent = await watch(fixture.context);
  const ownerBytes = await readFile(ownerFile(fixture.context), "utf8");
  fixture.livePids.delete(4242);
  await Promise.all([4343, 4444].map(pid => assert.rejects(watch({
    ...fixture.context, pid, scheduler: createScheduler(fixture.clock),
  }), error => error.exitCode === EXIT.CONFLICT)));
  assert.equal(await readFile(ownerFile(fixture.context), "utf8"), ownerBytes);
  assert.deepEqual(await readdir(fixture.context.paths.quarantine), []);
  await incumbent.stop();
});
test("an owner whose agent disagrees with its lock path fails as data corruption", async t => {
  const fixture = await watcherFixture(t);
  await watch(fixture.context);
  const owner = JSON.parse(await readFile(ownerFile(fixture.context), "utf8"));
  await writeFile(ownerFile(fixture.context),
    `${JSON.stringify({ ...owner, agent_id: "planner" })}\n`);
  await assert.rejects(watch({ ...fixture.context, pid: 4343 }),
    error => error.exitCode === EXIT.DATA);
});
test("malformed watcher ownership fails as data corruption", async t => {
  const fixture = await watcherFixture(t);
  await writeFile(ownerFile(fixture.context), "{\"schema_version\":1}\n");
  await assert.rejects(watch(fixture.context), error => error.exitCode === EXIT.DATA);
});
test("watcher immediately prints an existing unseen message and then marks it seen", async t => {
  const fixture = await watcherFixture(t);
  const message = await sendMessage(fixture.context, messageRequest());
  const watcher = await watch(fixture.context);
  assert.deepEqual(fixture.events, [{ event: "message", message, state: "unseen" }]);
  assert.equal(await pathExists(fixture.context.paths.seenFile(message.id, "models")), true);
  assert.equal((await listInbox(fixture.context, { agentId: "models" }))[0].state, "seen");
  await watcher.stop();
});
test("fallback scan delivers messages without a filesystem event and prints each id once", async t => {
  const fixture = await watcherFixture(t);
  const watcher = await watch(fixture.context);
  const message = await sendMessage(fixture.context, messageRequest());
  await fixture.scheduler.advance(1_999);
  assert.deepEqual(fixture.events, []);
  await fixture.scheduler.advance(1);
  await fixture.watchControl.emit();
  await fixture.scheduler.advance(2_000);
  assert.deepEqual(fixture.events.map(event => event.message.id), [message.id]);
  await watcher.stop();
});
test("restart prints unseen messages but leaves seen unacknowledged work discoverable", async t => {
  const fixture = await watcherFixture(t);
  const alreadySeen = await sendMessage(fixture.context, messageRequest({ subject: "seen" }));
  await markSeen(fixture.context, alreadySeen, "models");
  const first = await watch(fixture.context);
  assert.deepEqual(fixture.events, []);
  await first.stop();
  const unseen = await sendMessage(fixture.context, messageRequest({ subject: "new" }));
  const second = await watch(fixture.context);
  assert.deepEqual(fixture.events.map(event => event.message.id), [unseen.id]);
  const inbox = await listInbox(fixture.context, { agentId: "models" });
  assert.deepEqual(inbox.map(item => item.message.id), [alreadySeen.id, unseen.id]);
  assert.deepEqual(inbox.map(item => item.state), ["seen", "seen"]);
  await second.stop();
});
test("seen receipt is created only after successful complete output", async t => {
  let outputFinished = false;
  const fixture = await watcherFixture(t, {
    output: async () => {
      await Promise.resolve();
      outputFinished = true;
      throw new Error("terminal closed");
    },
  });
  const message = await sendMessage(fixture.context, messageRequest());
  await assert.rejects(watch(fixture.context), /terminal closed/);
  assert.equal(outputFinished, true);
  assert.equal(await pathExists(fixture.context.paths.seenFile(message.id, "models")), false);
  assert.equal((await readPresence(fixture.context)).status, "offline");
});
test("heartbeat refreshes presence every 15 seconds and extends owned claims", async t => {
  const fixture = await watcherFixture(t);
  const watcher = await watch(fixture.context);
  assert.deepEqual(fixture.extensions, ["models"]);
  assert.equal((await readPresence(fixture.context)).heartbeat_at, "2026-08-14T18:00:00.000Z");
  await fixture.scheduler.advance(14_999);
  assert.equal((await readPresence(fixture.context)).heartbeat_at, "2026-08-14T18:00:00.000Z");
  await fixture.scheduler.advance(1);
  assert.equal((await readPresence(fixture.context)).heartbeat_at, "2026-08-14T18:00:15.000Z");
  assert.deepEqual(fixture.extensions, ["models", "models"]);
  await watcher.stop();
});
test("heartbeat stays live while initial message output is blocked", async t => {
  const fixture = await watcherFixture(t);
  const gate = deferred(), outputCalled = deferred();
  fixture.context.output = async event => {
    fixture.events.push(event);
    outputCalled.resolve();
    await gate.promise;
  };
  await sendMessage(fixture.context, messageRequest());
  const starting = watch(fixture.context);
  await outputCalled.promise;
  await fixture.scheduler.advance(46_000);
  assert.equal((await readPresence(fixture.context)).heartbeat_at, "2026-08-14T18:00:45.000Z");
  fixture.livePids.add(4343);
  const contender = await watch({
    ...fixture.context, pid: 4343,
    scheduler: createScheduler(fixture.clock),
    output: async () => {},
  }).then(value => ({ value }), error => ({ error }));
  if (contender.value !== undefined) await contender.value.stop();
  assert.equal(contender.error?.exitCode, EXIT.CONFLICT);
  gate.resolve();
  const watcher = await starting;
  await watcher.stop();
});
test("a start racing normal stop waits for owner removal", async t => {
  const gate = deferred(), outputCalled = deferred();
  const fixture = await watcherFixture(t, { output: async () => {
    outputCalled.resolve(); await gate.promise;
  } });
  const incumbent = await watch(fixture.context);
  await sendMessage(fixture.context, messageRequest());
  const scanning = fixture.watchControl.emit();
  await outputCalled.promise;
  const stopping = incumbent.stop();
  fixture.livePids.add(4343);
  const successorContext = { ...fixture.context, pid: 4343,
    scheduler: createScheduler(fixture.clock) };
  await assert.rejects(watch(successorContext), error => error.exitCode === EXIT.CONFLICT);
  gate.resolve(); await scanning; await stopping;
  const successor = await watch(successorContext);
  await successor.stop();
});
test("stop closes event sources, writes offline presence, and resolves done", async t => {
  const fixture = await watcherFixture(t);
  const watcher = await watch(fixture.context);
  assert.equal(fixture.watchControl.active(), 1);
  await watcher.stop();
  await watcher.done;
  assert.equal(fixture.watchControl.active(), 0);
  assert.equal(fixture.scheduler.size(), 0);
  assert.equal((await readPresence(fixture.context)).status, "offline");
});
test("wait prioritizes its initial scan and catches delivery after watching starts", async t => {
  const fixture = await watcherFixture(t);
  const timedOut = waitForMessage(fixture.context, { agentId: "models", timeoutMs: 5 });
  await waitUntil(() => fixture.scheduler.size() > 0);
  await fixture.scheduler.advance(5);
  assert.equal(await timedOut, null);
  const existing = await sendMessage(fixture.context, messageRequest({ subject: "existing" }));
  const eagerContext = { ...fixture.context,
    scheduler: createScheduler(fixture.clock, { eagerZeroTimeout: true }),
  };
  assert.equal((await waitForMessage(eagerContext,
    { agentId: "models", timeoutMs: 0 })).id, existing.id);
  await markSeen(fixture.context, existing, "models");
  const scanGate = deferred();
  let initialScan = true;
  const waitingContext = { ...fixture.context, listInbox: async input => {
    const items = await listInbox(fixture.context, input);
    if (initialScan) { initialScan = false; await scanGate.promise; }
    return items;
  } };
  const pending = waitForMessage(waitingContext, { agentId: "models", timeoutMs: 100 });
  await waitUntil(() => !initialScan || fixture.scheduler.size() > 0);
  assert.equal(initialScan, false);
  const message = await sendMessage(fixture.context, messageRequest({ subject: "wake" }));
  const emitted = fixture.watchControl.emit();
  scanGate.resolve();
  await emitted;
  assert.equal((await pending).id, message.id);
  assert.equal(fixture.watchControl.active(), 0);
});
