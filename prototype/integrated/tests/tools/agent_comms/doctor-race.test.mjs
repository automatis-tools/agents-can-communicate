import assert from "node:assert/strict";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import test from "node:test";

import { initBus } from "../../../tools/agents/lib/identity.mjs";
import { markSeen, sendMessage } from "../../../tools/agents/lib/messages.mjs";
import { createBusPaths, ensureBusLayout } from "../../../tools/agents/lib/paths.mjs";
import { validateProtocol } from "../../../tools/agents/lib/schema.mjs";
import { runDoctor } from "../../../tools/agents/lib/status.mjs";
import { createBusFixture, createFakeClock, createGitWorktreeFixture, messageRequest,
  seedOpenAgent } from "./helpers.mjs";

function deferred() { let resolve;
  const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function ticks(count = 8) {
  for (let index = 0; index < count; index += 1)
    await new Promise(resolve => setImmediate(resolve));
}
function signalled(value) {
  return Promise.race([value, new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("repair hook was not reached")), 250);
    timer.unref();
  })]);
}
function racingContext(base, source) {
  const linked = deferred(), releaseLink = deferred(), removed = deferred(), published = deferred();
  let linkCount = 0;
  const context = { ...base,
    linkCorruptRecord: async (from, destination) => {
      linkCount += 1; const result = await link(from, destination);
      if (linkCount === 1) { linked.resolve(); await releaseLink.promise; }
      return result;
    },
    unlinkCorruptRecord: async from => {
      await unlink(from);
      if (from === source) { removed.resolve(); await published.promise; }
    },
  };
  return { context, linked, releaseLink, removed, published, links: () => linkCount };
}
async function seedAgents(context) {
  await Promise.all(["visual", "models"].map(agentId => seedOpenAgent(context,
    { agentId, task: "M2.7" })));
}

test("two doctors serialize while init publishes replacement protocol B", async t => {
  const fixture = await createGitWorktreeFixture(); t.after(fixture.cleanup);
  const paths = createBusPaths(fixture.bus); await ensureBusLayout(paths);
  const clock = createFakeClock("2026-08-14T18:00:00.000Z");
  const base = { paths, now: clock.now, pid: 4242, pidIsAlive: pid => pid === 4242 };
  await writeFile(paths.protocol, "{broken");
  const race = racingContext(base, paths.protocol);
  const first = runDoctor(race.context, { repair: true }); await race.linked.promise;
  const second = runDoctor(race.context, { repair: true }); await ticks();
  assert.equal(race.links(), 1);
  race.releaseLink.resolve(); await signalled(race.removed.promise);
  const replacement = await initBus(base); race.published.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(JSON.parse(await readFile(paths.protocol, "utf8")), replacement);
});

test("two doctors serialize while recipient publishes replacement seen B", async t => {
  const fixture = await createBusFixture(); t.after(fixture.cleanup);
  const base = { ...fixture.context, pid: 4242, pidIsAlive: pid => pid === 4242,
    randomUUID: () => "44444444-4444-4444-8444-444444444444" };
  await seedAgents(base);
  const protocol = validateProtocol({ schema_version: 1, protocol_version: 1,
    checkout_id: "c".repeat(64), checkout_root: fixture.root,
    initialized_at: base.now().toISOString() });
  await writeFile(base.paths.protocol, `${JSON.stringify(protocol)}\n`);
  const message = await sendMessage(base, messageRequest());
  const seen = base.paths.seenFile(message.id, "models"); await mkdir(base.paths.seen,
    { recursive: true }); await writeFile(seen, "{broken");
  const race = racingContext(base, seen);
  const first = runDoctor(race.context, { repair: true }); await race.linked.promise;
  const second = runDoctor(race.context, { repair: true }); await ticks();
  assert.equal(race.links(), 1);
  race.releaseLink.resolve(); await signalled(race.removed.promise);
  const replacement = await markSeen(base, message, "models"); race.published.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(JSON.parse(await readFile(seen, "utf8")), replacement);
});
