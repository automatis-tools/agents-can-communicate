// Combined regressions 9-11 from docs/MIGRATION.md. The 0004 recovery audits
// are exercised on top of the 0003 managed-root storage, which is where the
// reconciliation risk lives: the archived scanners were written against the
// pre-storage read signatures.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { writeJsonAtomic } from "../../../tools/agents/lib/atomic-json.mjs";
import { repairStaleClaimLock } from "../../../tools/agents/lib/claims.mjs";
import { markSeen, sendMessage } from "../../../tools/agents/lib/messages.mjs";
import { repairStaleRepairMutex } from "../../../tools/agents/lib/repair-mutex.mjs";
import { validateProtocol } from "../../../tools/agents/lib/schema.mjs";
import { runDoctor } from "../../../tools/agents/lib/status.mjs";
import { createBusFixture, messageRequest, pathExists, seedOpenAgent } from "./helpers.mjs";

const STALE_MS = 60_001;

async function setup(t) {
  const fixture = await createBusFixture();
  t.after(fixture.cleanup);
  const context = { ...fixture.context, pid: 4242, pidIsAlive: pid => pid === 4242,
    randomUUID: (() => { let value = 1; return () =>
      `11111111-1111-4111-8111-${String(value++).padStart(12, "0")}`; })(),
    randomMutexUUID: () => "22222222-2222-4222-8222-222222222222" };
  await Promise.all(["visual", "models"].map(agentId =>
    seedOpenAgent(context, { agentId, task: "M2.7" })));
  await writeJsonAtomic(context.paths.protocol, validateProtocol({ schema_version: 1,
    protocol_version: 1, checkout_id: "c".repeat(64), checkout_root: fixture.root,
    initialized_at: context.now().toISOString() }),
  { tmpDir: context.paths.tmp, exclusive: true });
  return { ...fixture, context };
}

function crash(message) { return Object.assign(new Error(message), { code: "SYNTHETIC_CRASH" }); }

async function seedClaimLock(context) {
  const directory = path.join(context.paths.locks, "claims.lock");
  await mkdir(directory);
  await writeJsonAtomic(path.join(directory, "owner.json"), { schema_version: 1,
    owner_agent: "visual", pid: 9999,
    acquired_at: new Date(context.now().getTime() - STALE_MS).toISOString() },
  { tmpDir: context.paths.tmp, exclusive: true });
  return directory;
}

async function seedMutex(context) {
  const directory = path.join(context.paths.locks, "watcher-models.lock");
  await mkdir(directory);
  await writeJsonAtomic(path.join(directory, "owner.json"), { schema_version: 1,
    kind: "watcher", agent_id: "models", pid: 9999,
    token: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    acquired_at: new Date(context.now().getTime() - STALE_MS).toISOString() },
  { tmpDir: context.paths.tmp, exclusive: true });
  return directory;
}

// A record doctor would otherwise quarantine, used to prove that one corrupt
// recovery artifact blocks repairs that have nothing to do with it.
async function unrelatedCorruptRecord(context) {
  const file = context.paths.inboxFile("models", "00000000-0000-4000-8000-000000000009");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "{not-json");
  return file;
}

test("10: a crash after claim-lock audit publication replays exactly once", async t => {
  const { context } = await setup(t);
  const active = await seedClaimLock(context);
  const killed = crash("kill after claim-lock audit publication");
  await assert.rejects(repairStaleClaimLock({ ...context,
    renameClaimLock: async () => { throw killed; } }), killed);

  const first = await runDoctor(context, { repair: true });

  assert.equal(first.repairs.some(item => item.action === "repair_stale_claim_lock"), true);
  assert.equal(await pathExists(active), false);
  assert.equal(first.ok, true);

  const quarantine = (await readdir(context.paths.quarantine)).sort();
  const second = await runDoctor(context, { repair: true });

  assert.equal(second.ok, true);
  assert.deepEqual(second.repairs, [], "replay was not idempotent");
  assert.deepEqual((await readdir(context.paths.quarantine)).sort(), quarantine);
});

test("10: a crash after mutex audit publication replays exactly once", async t => {
  const { context } = await setup(t);
  const active = await seedMutex(context);
  const killed = crash("kill after mutex audit publication");
  await assert.rejects(repairStaleRepairMutex({ ...context,
    renameRepairMutex: async () => { throw killed; } }, "watcher", "models"), killed);

  const first = await runDoctor(context, { repair: true });

  assert.equal(first.repairs.some(item => item.action === "repair_stale_watcher_mutex"), true);
  assert.equal(await pathExists(active), false);
  assert.equal(first.ok, true);

  const quarantine = (await readdir(context.paths.quarantine)).sort();
  const second = await runDoctor(context, { repair: true });

  assert.equal(second.ok, true);
  assert.deepEqual(second.repairs, [], "replay was not idempotent");
  assert.deepEqual((await readdir(context.paths.quarantine)).sort(), quarantine);
});

test("11: every recovery artifact family is inventoried and blocks unrelated repair", async t => {
  const digest = createHash("sha256").update("unmatched").digest("hex");
  const artifacts = [
    ["claims-audit-not-a-uuid.json", async file => writeFile(file, "{}\n")],
    [`claims-lock-stale-${digest}`, async file => mkdir(file)],
    ["mutex-audit-not-a-digest.json", async file => writeFile(file, "{}\n")],
    [`mutex-stale-${digest}`, async file => mkdir(file)],
    ["watcher-owner-stale-33333333-3333-4333-8333-333333333333.json",
      async file => writeFile(file, "{}\n")],
  ];

  for (const [name, create] of artifacts) {
    const { context } = await setup(t);
    const corrupt = await unrelatedCorruptRecord(context);
    await create(path.join(context.paths.quarantine, name));

    const report = await runDoctor(context, { repair: true });

    assert.equal(report.ok, false, `${name} was not inventoried`);
    assert.deepEqual(report.repairs, [], `${name} did not block unrelated repair`);
    assert.equal(await pathExists(corrupt), true,
      `${name} left an unrelated record repaired despite ambiguous recovery state`);
  }
});

test("9: two doctors and a publisher cannot delete the publisher's new generation", async t => {
  const { context } = await setup(t);
  const base = { ...context, randomUUID: () => "44444444-4444-4444-8444-444444444444" };
  const message = await sendMessage(base, messageRequest());
  const seen = base.paths.seenFile(message.id, "models");
  await mkdir(base.paths.seen, { recursive: true });
  await writeFile(seen, "{broken");

  let links = 0;
  const held = Promise.withResolvers();
  const linked = Promise.withResolvers();
  const removed = Promise.withResolvers();
  const published = Promise.withResolvers();
  const racing = { ...base,
    linkCorruptRecord: async (from, destination) => {
      links += 1;
      const result = await link(from, destination);
      if (links === 1) { linked.resolve(); await held.promise; }
      return result;
    },
    unlinkCorruptRecord: async from => {
      await unlink(from);
      if (from === seen) { removed.resolve(); await published.promise; }
    } };

  const first = runDoctor(racing, { repair: true });
  await linked.promise;
  const second = runDoctor(racing, { repair: true });
  for (let index = 0; index < 8; index += 1) await new Promise(setImmediate);

  // The repair mutex admits exactly one quarantine attempt at a time.
  assert.equal(links, 1, "two doctors quarantined the same record concurrently");
  held.resolve();
  await removed.promise;
  const replacement = await markSeen(base, message, "models");
  published.resolve();
  await Promise.all([first, second]);

  assert.deepEqual(JSON.parse(await readFile(seen, "utf8")), replacement,
    "a doctor deleted the publisher's replacement generation");
  const after = await runDoctor(base, {});
  assert.deepEqual(after.issues.filter(item => item.code.includes("CORRUPT")), [],
    "the workspace was left with corrupt recovery state after the race");
});
