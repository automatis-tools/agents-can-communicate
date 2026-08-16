import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { writeJsonAtomic } from "../../../tools/agents/lib/atomic-json.mjs";
import { EXIT } from "../../../tools/agents/lib/errors.mjs";
import { sendMessage } from "../../../tools/agents/lib/messages.mjs";
import {
  repairStaleWatcherOwnership, startWatcher,
} from "../../../tools/agents/lib/presence.mjs";
import { validateClaim, validateProtocol } from "../../../tools/agents/lib/schema.mjs";
import { collectStatus, enforcementExit, runDoctor } from "../../../tools/agents/lib/status.mjs";
import {
  createBusFixture, messageRequest, pathExists, seedAcknowledgement,
  seedOpenAgent, seedPresence,
} from "./helpers.mjs";

async function fixtureFor(t, { protocol = true } = {}) {
  const fixture = await createBusFixture();
  t.after(fixture.cleanup);
  const livePids = new Set([4242]);
  const context = {
    ...fixture.context, pid: 4242, pidIsAlive: pid => livePids.has(pid),
    randomUUID: () => "00000000-0000-4000-8000-000000000001",
    listActiveAgentIds: async () => ["visual", "models"],
  };
  await Promise.all(["visual", "models"].map(agentId => seedOpenAgent(context,
    { agentId, task: "M2.7" })));
  if (protocol) {
    const record = validateProtocol({ schema_version: 1, protocol_version: 1,
      checkout_id: "c".repeat(64), checkout_root: fixture.root,
      initialized_at: context.now().toISOString() });
    await writeJsonAtomic(context.paths.protocol, record,
      { tmpDir: context.paths.tmp, exclusive: true });
  }
  return { ...fixture, context, livePids };
}

function storedMessage(context, id, overrides = {}) {
  return {
    schema_version: 1, id, from: "visual", to: "models", type: "status",
    severity: "info", subject: "replacement", body: "valid B", task: "M2.7",
    reply_to: null, requires_ack: false, created_at: context.now().toISOString(),
    sender_head: "a".repeat(40), attachments: [], ...overrides,
  };
}

async function seedStaleClaimLock(context) {
  const directory = path.join(context.paths.locks, "claims.lock");
  await mkdir(directory);
  await writeFile(path.join(directory, "owner.json"), `${JSON.stringify({
    schema_version: 1, owner_agent: "visual", pid: 9999,
    acquired_at: new Date(context.now().getTime() - 60_001).toISOString(),
  })}\n`);
  return directory;
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test("corrupt quarantine retains a valid replacement published before snapshot", async t => {
  const { context } = await fixtureFor(t);
  const source = context.paths.inboxFile("models", "broken");
  await mkdir(path.dirname(source), { recursive: true });
  await writeFile(source, "{not-json");
  const replacement = storedMessage(context, "broken");
  const racing = { ...context, linkCorruptRecord: async (from, destination) => {
    await unlink(from);
    await writeFile(from, `${JSON.stringify(replacement)}\n`);
    return link(from, destination);
  } };
  const report = await runDoctor(racing, { repair: true });
  assert.equal(report.ok, true);
  assert.deepEqual(JSON.parse(await readFile(source, "utf8")), replacement);
  assert.equal(report.repairs.some(item => item.action === "quarantine_corrupt_json"), false);
});

test("doctor refuses to quarantine mutable presence without its writer mutex", async t => {
  const { context } = await fixtureFor(t);
  const presencePath = context.paths.presenceFile("models");
  await writeFile(presencePath, "{not-json");
  const report = await runDoctor(context, { repair: true });
  assert.equal(report.ok, false);
  assert.equal(await pathExists(presencePath), true);
  assert.equal(report.repairs.some(item => item.path === presencePath), false);
});

test("watcher mutex serializes two repairs with a replacement owner", async t => {
  const { context, livePids } = await fixtureFor(t);
  livePids.delete(4242);
  const active = path.join(context.paths.locks, "watcher-models.json");
  const ownerA = { schema_version: 1, agent_id: "models", pid: 9999,
    token: "11111111-1111-4111-8111-111111111111",
    acquired_at: new Date(context.now().getTime() - 60_001).toISOString() };
  await writeFile(active, `${JSON.stringify(ownerA)}\n`);
  const linked = deferred(), release = deferred();
  const repairContext = { ...context, linkWatcherOwner: async (source, destination) => {
    try {
      const result = await link(source, destination);
      linked.resolve(); await release.promise; return result;
    } catch (error) {
      if (error.code === "EEXIST") await release.promise;
      throw error;
    }
  } };
  const first = repairStaleWatcherOwnership(repairContext, "models");
  await linked.promise;
  const mutexHeld = await pathExists(path.join(context.paths.locks, "watcher-models.lock"));
  livePids.add(4242);
  const scheduler = { setInterval: () => 1, clearInterval: () => {},
    setTimeout: () => 2, clearTimeout: () => {} };
  const watcherResult = startWatcher({ ...context, scheduler,
    watchDirectory: () => ({ close: () => {}, once: () => {} }), output: async () => {},
    extendOwnedClaims: async () => {} }, { agentId: "models" })
    .then(value => ({ value }), error => ({ error }));
  const second = repairStaleWatcherOwnership(repairContext, "models");
  release.resolve();
  assert.equal(await first, true);
  const watcher = await watcherResult;
  assert.equal(watcher.error, undefined);
  assert.equal(await second, false);
  assert.equal(mutexHeld, true);
  assert.equal(JSON.parse(await readFile(active, "utf8")).pid, 4242);
  await watcher.value.stop();
});

test("missing protocol is data corruption until init", async t => {
  const { context } = await fixtureFor(t, { protocol: false });
  const status = await collectStatus(context);
  assert.equal(enforcementExit(status, {}), EXIT.DATA);
  const doctor = await runDoctor(context, {});
  assert.equal(doctor.ok, false);
  assert.equal(doctor.issues[0].code, "PROTOCOL_MISSING");
});

test("corrupt data takes precedence over stale and pending enforcement", async t => {
  const { context, clock } = await fixtureFor(t);
  await seedPresence(context, { agentId: "visual", pid: 4242,
    heartbeatAt: clock.advance(-45_001).toISOString() });
  clock.advance(45_001);
  await sendMessage(context, messageRequest());
  const corruptPath = context.paths.inboxFile("models", "broken");
  await writeFile(corruptPath, "{not-json");
  const status = await collectStatus(context);
  assert.equal(enforcementExit(status, { failOnStale: true, failOnPending: true }), EXIT.DATA);
});

test("heartbeat-less open registry becomes stale only after forty-five seconds", async t => {
  const { context, clock } = await fixtureFor(t);
  let status = await collectStatus(context);
  assert.deepEqual(status.agents.offline.map(item => item.agent_id), ["models", "visual"]);
  clock.advance(45_000);
  status = await collectStatus(context);
  assert.deepEqual(status.agents.stale, []);
  clock.advance(1);
  status = await collectStatus(context);
  assert.deepEqual(status.agents.stale.map(item => item.agent_id), ["models", "visual"]);
});

test("claim path digest and scope uniqueness are status invariants", async t => {
  const { context } = await fixtureFor(t);
  const claim = validateClaim({ schema_version: 1, agent_id: "visual", task: "M2.7",
    scope: "game/presentation", reason: "camera", created_at: context.now().toISOString(),
    updated_at: context.now().toISOString(),
    expires_at: new Date(context.now().getTime() + 60_000).toISOString() });
  const canonical = path.join(context.paths.claims,
    `${createHash("sha256").update(claim.scope).digest("hex")}.json`);
  const duplicate = path.join(context.paths.claims, "wrong-name.json");
  await Promise.all([canonical, duplicate].map(filePath => writeJsonAtomic(filePath, claim,
    { tmpDir: context.paths.tmp, exclusive: true })));
  const report = await collectStatus(context);
  assert.deepEqual(report.claims.active, []);
  assert.deepEqual(report.corrupt, [canonical, duplicate].sort());
});

test("doctor inventories audit checksum and filename binding on every run", async t => {
  const { context } = await fixtureFor(t);
  const source = context.paths.inboxFile("models", "broken");
  await mkdir(path.dirname(source), { recursive: true });
  await writeFile(source, "{not-json");
  const repaired = await runDoctor(context, { repair: true });
  const record = repaired.repairs[0];
  const original = await readFile(record.quarantine_path);
  await writeFile(record.quarantine_path, "changed");
  let doctor = await runDoctor(context, {});
  assert.equal(doctor.ok, false);
  assert.equal(doctor.issues.some(item => item.path === record.audit_path), true);
  await writeFile(record.quarantine_path, original);
  const wrong = path.join(context.paths.quarantine, `doctor-audit-${"0".repeat(64)}.json`);
  await rename(record.audit_path, wrong);
  doctor = await runDoctor(context, {});
  assert.equal(doctor.issues.some(item => item.path === wrong), true);
});

test("unknown protocol version blocks every repair mutation", async t => {
  const { context } = await fixtureFor(t, { protocol: false });
  const unknown = { schema_version: 1, protocol_version: 2, checkout_id: "c".repeat(64),
    checkout_root: path.dirname(context.paths.root), initialized_at: context.now().toISOString() };
  await writeFile(context.paths.protocol, `${JSON.stringify(unknown)}\n`);
  const message = await sendMessage(context, messageRequest());
  await seedAcknowledgement(context, message);
  const lockDirectory = await seedStaleClaimLock(context);
  const report = await runDoctor(context, { repair: true });
  assert.equal(report.ok, false);
  assert.equal(await pathExists(context.paths.inboxFile("models", message.id)), true);
  assert.equal(await pathExists(context.paths.archiveFile("models", message.id)), false);
  assert.equal(await pathExists(lockDirectory), true);
  assert.deepEqual(await readdir(context.paths.quarantine), []);
});

test("quarantining a corrupt protocol stops all later repairs until init", async t => {
  const { context } = await fixtureFor(t);
  await writeFile(context.paths.protocol, "{not-json");
  const message = await sendMessage(context, messageRequest());
  await seedAcknowledgement(context, message);
  const lockDirectory = await seedStaleClaimLock(context);
  const report = await runDoctor(context, { repair: true });
  assert.equal(report.ok, false);
  assert.equal(report.issues.some(item => item.code === "PROTOCOL_MISSING"), true);
  assert.deepEqual(report.repairs.map(item => item.path), [context.paths.protocol]);
  assert.equal(await pathExists(context.paths.inboxFile("models", message.id)), true);
  assert.equal(await pathExists(context.paths.archiveFile("models", message.id)), false);
  assert.equal(await pathExists(lockDirectory), true);
});

test("archive recovery never overwrites a concurrently published destination", async t => {
  const { context } = await fixtureFor(t);
  const message = await sendMessage(context, messageRequest());
  await seedAcknowledgement(context, message);
  const source = context.paths.inboxFile("models", message.id);
  const destination = context.paths.archiveFile("models", message.id);
  const replacement = Buffer.from(`${JSON.stringify({ ...message, body: "concurrent B" })}\n`);
  const racing = { ...context, linkArchiveRecord: async (from, to) => {
    await mkdir(path.dirname(to), { recursive: true });
    await writeFile(to, replacement);
    return link(from, to);
  } };
  await assert.rejects(runDoctor(racing, { repair: true }),
    error => error.exitCode === EXIT.DATA);
  assert.equal(await readFile(destination, "utf8"), replacement.toString());
  assert.equal(await pathExists(source), true);
});

test("archive recovery accepts an identical immutable destination", async t => {
  const { context } = await fixtureFor(t);
  const message = await sendMessage(context, messageRequest());
  await seedAcknowledgement(context, message);
  const source = context.paths.inboxFile("models", message.id);
  const destination = context.paths.archiveFile("models", message.id);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, await readFile(source));
  const report = await runDoctor(context, { repair: true });
  assert.equal(report.ok, true);
  assert.equal(await pathExists(source), false);
  assert.deepEqual(JSON.parse(await readFile(destination, "utf8")), message);
});
