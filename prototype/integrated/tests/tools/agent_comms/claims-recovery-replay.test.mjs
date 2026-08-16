import assert from "node:assert/strict";
import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { writeJsonAtomic } from "../../../tools/agents/lib/atomic-json.mjs";
import { claimScope, forceReleaseStaleScope, repairStaleClaimLock }
  from "../../../tools/agents/lib/claims.mjs";
import { validateProtocol } from "../../../tools/agents/lib/schema.mjs";
import { runDoctor } from "../../../tools/agents/lib/status.mjs";
import { createBusFixture, pathExists, seedOpenAgent } from "./helpers.mjs";

async function setup(t) {
  const fixture = await createBusFixture(); t.after(fixture.cleanup);
  const context = { ...fixture.context, pid: 4242, pidIsAlive: pid => pid === 4242,
    randomUUID: (() => { let value = 1; return () =>
      `11111111-1111-4111-8111-${String(value++).padStart(12, "0")}`; })(),
    randomMutexUUID: () => "22222222-2222-4222-8222-222222222222" };
  await Promise.all([
    seedOpenAgent(context, { agentId: "visual", task: "M2.7" }),
    seedOpenAgent(context, { agentId: "models", task: "M2.7" }),
    seedOpenAgent(context, { agentId: "ops", role: "orchestrator", task: "M2.7" }),
  ]);
  await writeJsonAtomic(context.paths.protocol, validateProtocol({ schema_version: 1,
    protocol_version: 1, checkout_id: "c".repeat(64), checkout_root: fixture.root,
    initialized_at: context.now().toISOString() }),
  { tmpDir: context.paths.tmp, exclusive: true });
  return { ...fixture, context };
}
function lockOwner(context, overrides = {}) {
  return { schema_version: 1, owner_agent: "visual", pid: 9999,
    acquired_at: new Date(context.now().getTime() - 60_001).toISOString(), ...overrides };
}
async function seedClaimLock(context, owner = lockOwner(context)) {
  const directory = path.join(context.paths.locks, "claims.lock");
  await mkdir(directory);
  await writeJsonAtomic(path.join(directory, "owner.json"), owner,
    { tmpDir: context.paths.tmp, exclusive: true });
  return directory;
}
async function seedStaleClaim(context) {
  await claimScope(context, { agentId: "visual", scope: "game/presentation",
    reason: "camera", leaseSeconds: 60 });
  const claimPath = path.join(context.paths.claims, (await readdir(context.paths.claims))[0]);
  const claim = JSON.parse(await readFile(claimPath));
  const stale = { ...claim, expires_at: new Date(context.now().getTime() - 1).toISOString() };
  await writeJsonAtomic(claimPath, stale, { tmpDir: context.paths.tmp, exclusive: false });
  return { claimPath, stale };
}
function crash(message) { return Object.assign(new Error(message), { code: "SYNTHETIC_CRASH" }); }

test("doctor replays stale claim-lock rename after immutable audit publication", async t => {
  const { context } = await setup(t); const active = await seedClaimLock(context);
  const killed = crash("kill after claim-lock audit publication");
  await assert.rejects(repairStaleClaimLock({ ...context,
    renameClaimLock: async () => { throw killed; } }), killed);
  assert.equal((await readdir(context.paths.quarantine))
    .filter(name => name.startsWith("claims-audit-")).length, 1);

  const report = await runDoctor(context, { repair: true });

  assert.equal(report.repairs.some(item => item.action === "repair_stale_claim_lock"), true);
  assert.equal(await pathExists(active), false);
  assert.equal(report.ok, true);
});

test("pending claim-lock audit never moves a replacement owner generation", async t => {
  const { context } = await setup(t); const active = await seedClaimLock(context);
  const killed = crash("kill after claim-lock audit publication");
  await assert.rejects(repairStaleClaimLock({ ...context,
    renameClaimLock: async () => { throw killed; } }), killed);
  const replacement = lockOwner(context, { owner_agent: "models", pid: 4242,
    acquired_at: context.now().toISOString() });
  await writeJsonAtomic(path.join(active, "owner.json"), replacement,
    { tmpDir: context.paths.tmp, exclusive: false });

  const report = await runDoctor(context, { repair: true });

  assert.equal(report.ok, false); assert.equal(report.repairs.length, 0);
  assert.deepEqual(JSON.parse(await readFile(path.join(active, "owner.json"))), replacement);
});

test("doctor replays force-release unlink after immutable audit publication", async t => {
  const { context } = await setup(t); const { claimPath } = await seedStaleClaim(context);
  const killed = crash("kill after force-release audit publication");
  await assert.rejects(forceReleaseStaleScope({ ...context,
    unlinkClaimRecord: async () => { throw killed; } }, { agentId: "ops",
    ownerAgent: "visual", scope: "game/presentation" }), killed);
  const pending = await runDoctor(context, {});
  assert.equal(pending.ok, false);
  assert.equal(pending.issues.some(item => item.code === "PENDING_FORCE_RELEASE"), true);

  const report = await runDoctor(context, { repair: true });

  assert.equal(report.repairs.some(item => item.action === "complete_pending_force_release"), true);
  assert.equal(await pathExists(claimPath), false);
  assert.equal(report.ok, true);
});

test("pending force-release audit never unlinks a replacement claim generation", async t => {
  const { context } = await setup(t); const { claimPath, stale } = await seedStaleClaim(context);
  const killed = crash("kill after force-release audit publication");
  await assert.rejects(forceReleaseStaleScope({ ...context,
    unlinkClaimRecord: async () => { throw killed; } }, { agentId: "ops",
    ownerAgent: "visual", scope: "game/presentation" }), killed);
  const replacement = { ...stale, agent_id: "models", task: "M2.7", reason: "replacement",
    created_at: context.now().toISOString(), updated_at: context.now().toISOString(),
    expires_at: new Date(context.now().getTime() + 60_000).toISOString() };
  await writeJsonAtomic(claimPath, replacement, { tmpDir: context.paths.tmp, exclusive: false });

  const report = await runDoctor(context, { repair: true });

  assert.equal(report.ok, false); assert.equal(report.repairs.length, 0);
  assert.deepEqual(JSON.parse(await readFile(claimPath)), replacement);
});
