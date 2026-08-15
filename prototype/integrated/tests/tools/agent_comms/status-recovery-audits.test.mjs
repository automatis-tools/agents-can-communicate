import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { writeJsonAtomic } from "../../../tools/agents/lib/atomic-json.mjs";
import { claimScope, forceReleaseStaleScope } from "../../../tools/agents/lib/claims.mjs";
import { sendMessage } from "../../../tools/agents/lib/messages.mjs";
import { repairStaleRepairMutex } from "../../../tools/agents/lib/repair-mutex.mjs";
import { validateProtocol } from "../../../tools/agents/lib/schema.mjs";
import { collectStatus, runDoctor } from "../../../tools/agents/lib/status.mjs";
import { createBusFixture, messageRequest, pathExists, seedAcknowledgement,
  seedOpenAgent } from "./helpers.mjs";

const UUID = "11111111-1111-4111-8111-111111111111";
async function setup(t) {
  const fixture = await createBusFixture(); t.after(fixture.cleanup);
  const context = { ...fixture.context, pid: 4242, pidIsAlive: pid => pid === 4242,
    randomMutexUUID: () => "22222222-2222-4222-8222-222222222222" };
  await Promise.all(["visual", "models"].map(agentId => seedOpenAgent(context,
    { agentId, task: "M2.7" })).concat(seedOpenAgent(context,
    { agentId: "ops", role: "orchestrator", task: "M2.7" })));
  const protocol = validateProtocol({ schema_version: 1, protocol_version: 1,
    checkout_id: "c".repeat(64), checkout_root: fixture.root,
    initialized_at: context.now().toISOString() });
  await writeJsonAtomic(context.paths.protocol, protocol,
    { tmpDir: context.paths.tmp, exclusive: true });
  return { ...fixture, context };
}
function mutexOwner(context, overrides = {}) {
  return { schema_version: 1, kind: "watcher", agent_id: "models", pid: 9999,
    token: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    acquired_at: new Date(context.now().getTime() - 60_001).toISOString(), ...overrides };
}
async function seedMutex(context, owner) {
  const directory = path.join(context.paths.locks, "watcher-models.lock");
  await mkdir(directory);
  await writeJsonAtomic(path.join(directory, "owner.json"), owner,
    { tmpDir: context.paths.tmp, exclusive: true });
  return directory;
}
function claimLockOwner(context, overrides = {}) {
  return { schema_version: 1, owner_agent: "visual", pid: 9999,
    acquired_at: new Date(context.now().getTime() - 60_001).toISOString(), ...overrides };
}
function claimLockDigest(owner) {
  return createHash("sha256").update(JSON.stringify([
    owner.schema_version, owner.owner_agent, owner.pid, owner.acquired_at,
  ])).digest("hex");
}
function claimAudit(context, owner, overrides = {}) {
  return { schema_version: 1, action: "repair_stale_claim_lock", actor_agent: null,
    recorded_at: context.now().toISOString(), target: owner, ...overrides };
}
function staleClaim(context) {
  return { schema_version: 1, agent_id: "visual", task: "M2.7",
    scope: "game/presentation", reason: "camera",
    created_at: new Date(context.now().getTime() - 120_000).toISOString(),
    updated_at: new Date(context.now().getTime() - 120_000).toISOString(),
    expires_at: new Date(context.now().getTime() - 60_000).toISOString() };
}
function watcherOwner(context, overrides = {}) {
  return { schema_version: 1, agent_id: "models", pid: 9999, token: UUID,
    acquired_at: new Date(context.now().getTime() - 60_001).toISOString(), ...overrides };
}
async function json(context, filePath, value) {
  await writeJsonAtomic(filePath, value, { tmpDir: context.paths.tmp, exclusive: true });
}
async function acknowledgedMessage(context) {
  const message = await sendMessage(context, messageRequest());
  await seedAcknowledgement(context, message); return message;
}

test("doctor replays an exact stale mutex generation after audit publication", async t => {
  const { context } = await setup(t); const active = await seedMutex(context, mutexOwner(context));
  const crash = new Error("synthetic crash after immutable audit publication");
  await assert.rejects(repairStaleRepairMutex({ ...context,
    renameRepairMutex: async () => { throw crash; } }, "watcher", "models"), crash);
  assert.equal((await readdir(context.paths.quarantine))
    .filter(name => name.startsWith("mutex-audit-")).length, 1);

  const report = await runDoctor(context, { repair: true });

  assert.equal(report.repairs.some(item => item.action === "repair_stale_watcher_mutex"), true);
  assert.equal(await pathExists(active), false);
  assert.equal(report.ok, true);
});

test("pending mutex audit with a different active owner generation fails closed", async t => {
  const { context } = await setup(t); const active = await seedMutex(context, mutexOwner(context));
  const crash = new Error("synthetic crash after immutable audit publication");
  await assert.rejects(repairStaleRepairMutex({ ...context,
    renameRepairMutex: async () => { throw crash; } }, "watcher", "models"), crash);
  await writeFile(path.join(active, "owner.json"), `${JSON.stringify(mutexOwner(context,
    { token: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }), null, 2)}\n`);

  const report = await runDoctor(context, { repair: true });

  assert.equal(report.ok, false);
  assert.equal(report.repairs.length, 0);
  assert.equal(await pathExists(active), true);
});

test("pending mutex audit does not excuse a quarantine generation missing its owner", async t => {
  const { context } = await setup(t); const active = await seedMutex(context, mutexOwner(context));
  const crash = new Error("synthetic crash after immutable audit publication");
  await assert.rejects(repairStaleRepairMutex({ ...context,
    renameRepairMutex: async () => { throw crash; } }, "watcher", "models"), crash);
  const auditName = (await readdir(context.paths.quarantine))
    .find(name => name.startsWith("mutex-audit-"));
  const audit = JSON.parse(await readFile(path.join(context.paths.quarantine, auditName)));
  await mkdir(audit.quarantine_path);

  const report = await runDoctor(context, { repair: true });

  assert.equal(report.ok, false);
  assert.equal(report.repairs.length, 0);
  assert.equal(await pathExists(active), true);
});

test("status accepts fully bound claim and watcher recovery artifacts", async t => {
  const { context } = await setup(t); const owner = claimLockOwner(context);
  const digest = claimLockDigest(owner);
  const stale = path.join(context.paths.quarantine, `claims-lock-stale-${digest}`);
  await mkdir(stale);
  await Promise.all([
    json(context, path.join(stale, "owner.json"), owner),
    json(context, path.join(context.paths.quarantine, `claims-audit-${UUID}.json`),
      claimAudit(context, owner)),
    json(context, path.join(context.paths.quarantine,
      "claims-audit-33333333-3333-4333-8333-333333333333.json"),
    claimAudit(context, staleClaim(context), { action: "force_release_stale_claim",
      actor_agent: "models" })),
    json(context, path.join(context.paths.quarantine, `watcher-owner-stale-${UUID}.json`),
      watcherOwner(context)),
  ]);

  assert.deepEqual((await collectStatus(context)).corrupt, []);
});

test("status validates the force-release audit emitted by the public claims API", async t => {
  const { context } = await setup(t);
  await claimScope(context, { agentId: "visual", scope: "game/presentation",
    reason: "camera", leaseSeconds: 60 });
  const claimPath = path.join(context.paths.claims, (await readdir(context.paths.claims))[0]);
  const claim = JSON.parse(await readFile(claimPath));
  await writeJsonAtomic(claimPath, { ...claim,
    expires_at: new Date(context.now().getTime() - 1).toISOString() },
  { tmpDir: context.paths.tmp, exclusive: false });

  await forceReleaseStaleScope(context, { agentId: "ops", ownerAgent: "visual",
    scope: "game/presentation" });

  assert.deepEqual((await collectStatus(context)).corrupt, []);
});

for (const [name, damage] of [
  ["malformed claim audit filename", async context => {
    const filePath = path.join(context.paths.quarantine, "claims-audit-invalid.json");
    await json(context, filePath, claimAudit(context, claimLockOwner(context)));
    return filePath;
  }],
  ["claim-lock audit without its quarantined generation", async context => {
    const filePath = path.join(context.paths.quarantine, `claims-audit-${UUID}.json`);
    await json(context, filePath, claimAudit(context, claimLockOwner(context)));
    return filePath;
  }],
  ["force-release audit without an actor", async context => {
    const filePath = path.join(context.paths.quarantine, `claims-audit-${UUID}.json`);
    await json(context, filePath, claimAudit(context, staleClaim(context),
      { action: "force_release_stale_claim" })); return filePath;
  }],
  ["force-release audit for a non-stale claim", async context => {
    const filePath = path.join(context.paths.quarantine, `claims-audit-${UUID}.json`);
    const target = { ...staleClaim(context),
      expires_at: new Date(context.now().getTime() + 60_000).toISOString() };
    await json(context, filePath, claimAudit(context, target,
      { action: "force_release_stale_claim", actor_agent: "models" })); return filePath;
  }],
  ["claim-lock generation without its audit", async context => {
    const owner = claimLockOwner(context); const digest = claimLockDigest(owner);
    const filePath = path.join(context.paths.quarantine, `claims-lock-stale-${digest}`);
    await mkdir(filePath); await json(context, path.join(filePath, "owner.json"), owner);
    return filePath;
  }],
  ["claim-lock filename digest mismatch", async context => {
    const owner = claimLockOwner(context); const filePath = path.join(context.paths.quarantine,
      `claims-lock-stale-${"0".repeat(64)}`);
    await mkdir(filePath); await json(context, path.join(filePath, "owner.json"), owner);
    await json(context, path.join(context.paths.quarantine, `claims-audit-${UUID}.json`),
      claimAudit(context, owner)); return filePath;
  }],
  ["claim-lock generation with no owner record", async context => {
    const filePath = path.join(context.paths.quarantine, `claims-lock-stale-${"0".repeat(64)}`);
    await mkdir(filePath); return filePath;
  }],
  ["claim-lock audit owner mismatch", async context => {
    const owner = claimLockOwner(context); const digest = claimLockDigest(owner);
    const filePath = path.join(context.paths.quarantine, `claims-audit-${UUID}.json`);
    const stale = path.join(context.paths.quarantine, `claims-lock-stale-${digest}`);
    await mkdir(stale); await json(context, path.join(stale, "owner.json"), owner);
    await json(context, filePath, claimAudit(context, { ...owner, pid: 9998 })); return filePath;
  }],
  ["watcher owner filename token mismatch", async context => {
    const filePath = path.join(context.paths.quarantine,
      "watcher-owner-stale-22222222-2222-4222-8222-222222222222.json");
    await json(context, filePath, watcherOwner(context)); return filePath;
  }],
  ["watcher owner malformed canonical filename", async context => {
    const filePath = path.join(context.paths.quarantine, `watcher-owner-stale-${UUID}.json.extra`);
    await json(context, filePath, watcherOwner(context)); return filePath;
  }],
]) test(`${name} is corrupt and blocks unrelated repair`, async t => {
  const { context } = await setup(t); const artifact = await damage(context);
  const message = await acknowledgedMessage(context);

  const report = await runDoctor(context, { repair: true });

  assert.equal(report.issues.some(item => item.path === artifact), true);
  assert.equal(report.repairs.length, 0);
  assert.equal(await pathExists(context.paths.inboxFile(message.to, message.id)), true);
});
