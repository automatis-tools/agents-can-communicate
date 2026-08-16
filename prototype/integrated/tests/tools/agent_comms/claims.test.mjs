import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { claimScope, extendClaims, forceReleaseStaleScope, normalizeScope,
  releaseOwnedClaims, releaseScope, repairStaleClaimLock, scopesOverlap,
} from "../../../tools/agents/lib/claims.mjs";
import { writeJsonAtomic } from "../../../tools/agents/lib/atomic-json.mjs";
import { EXIT } from "../../../tools/agents/lib/errors.mjs";
import { createBusFixture, pathExists, seedOpenAgent } from "./helpers.mjs";
const lockDir = context => path.join(context.paths.locks, "claims.lock");
const lockOwnerFile = context => path.join(lockDir(context), "owner.json");
async function fixtureFor(t, agents = [{ agentId: "visual" }, { agentId: "models" }]) {
  const fixture = await createBusFixture();
  t.after(fixture.cleanup);
  const context = {
    ...fixture.context, pid: 4242, pidIsAlive: () => false,
    randomUUID: (() => {
      let index = 0;
      return () => `00000000-0000-4000-8000-${String(++index).padStart(12, "0")}`;
    })(),
  };
  await Promise.all(agents.map(agent => seedOpenAgent(context, { task: "M2.7", ...agent })));
  return { ...fixture, context };
}
async function claimFiles(context) {
  return (await readdir(context.paths.claims)).filter(name => name.endsWith(".json"));
}
async function claims(context) {
  return Promise.all((await claimFiles(context)).map(async name => JSON.parse(
    await readFile(path.join(context.paths.claims, name), "utf8"),
  )));
}
async function auditFiles(context) {
  return (await readdir(context.paths.quarantine))
    .filter(name => name.startsWith("claims-audit-")).sort();
}
async function seedLock(context, { agent = "visual", pid = 1234, acquiredAt } = {}) {
  await mkdir(lockDir(context));
  const record = {
    schema_version: 1, owner_agent: agent, pid,
    acquired_at: acquiredAt ?? context.now().toISOString(),
  };
  await writeFile(lockOwnerFile(context), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}
function deferred() {
  let resolve; const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
test("path overlap uses segments rather than string prefixes", () => {
  assert.equal(scopesOverlap("game/presentation", "game/presentation/camera"), true);
  assert.equal(scopesOverlap("game/presentation", "game/presentations"), false);
  assert.deepEqual(normalizeScope("game/presentation"), {
    kind: "path", value: "game/presentation",
  });
});
test("named contracts overlap only on exact normalized name", () => {
  assert.equal(scopesOverlap(
    "contract:tank-registration-v1", "contract:tank-registration-v1",
  ), true);
  assert.equal(scopesOverlap(
    "contract:tank-registration-v1", "contract:tank-registration-v2",
  ), false);
  assert.deepEqual(normalizeScope("contract:tank-registration-v1"), {
    kind: "contract", value: "tank-registration-v1",
  });
});
test("trailing slash normalizes and same-agent renewal stays one claim", async t => {
  const fixture = await fixtureFor(t);
  const first = await claimScope(fixture.context, {
    agentId: "visual", scope: "game/presentation/", reason: "camera", leaseSeconds: 10,
  });
  fixture.clock.advance(2_000);
  const renewed = await claimScope(fixture.context, {
    agentId: "visual", scope: "game/presentation", reason: "camera", leaseSeconds: 20,
  });
  assert.equal((await claimFiles(fixture.context)).length, 1);
  assert.equal(first.scope, "game/presentation");
  assert.equal(renewed.created_at, first.created_at);
  assert.equal(renewed.updated_at, "2026-08-14T18:00:02.000Z");
  assert.equal(renewed.expires_at, "2026-08-14T18:00:22.000Z");
});
test("overlapping claim by another agent is a conflict with exit code five", async t => {
  const fixture = await fixtureFor(t);
  await claimScope(fixture.context, {
    agentId: "visual", scope: "game/presentation", reason: "camera",
  });
  await assert.rejects(claimScope(fixture.context, {
    agentId: "models", scope: "game/presentation/camera", reason: "rig",
  }), error => error.exitCode === EXIT.CONFLICT && error.details.owner === "visual");
  assert.deepEqual((await claims(fixture.context)).map(record => record.agent_id), ["visual"]);
});
test("an expired claim remains unavailable until explicitly released", async t => {
  const fixture = await fixtureFor(t);
  await claimScope(fixture.context, {
    agentId: "visual", scope: "game/presentation", reason: "camera", leaseSeconds: 1,
  });
  fixture.clock.advance(1_001);
  await assert.rejects(claimScope(fixture.context, {
    agentId: "models", scope: "game/presentation", reason: "rig",
  }), error => error.exitCode === EXIT.CONFLICT);
  assert.equal((await claims(fixture.context))[0].agent_id, "visual");
});
test("watcher extension renews every claim owned by its agent", async t => {
  const fixture = await fixtureFor(t);
  await claimScope(fixture.context, {
    agentId: "visual", scope: "game/presentation", reason: "camera", leaseSeconds: 1,
  });
  await claimScope(fixture.context, {
    agentId: "visual", scope: "contract:tank-registration-v1", reason: "contract",
  });
  fixture.clock.advance(2_000);
  const extended = await extendClaims(fixture.context, "visual");
  assert.equal(extended.length, 2);
  assert.deepEqual(extended.map(record => record.updated_at), [
    "2026-08-14T18:00:02.000Z", "2026-08-14T18:00:02.000Z",
  ]);
  assert.deepEqual(extended.map(record => record.expires_at), [
    "2026-08-14T18:30:02.000Z", "2026-08-14T18:30:02.000Z",
  ]);
});
test("ordinary release is owner-only", async t => {
  const fixture = await fixtureFor(t);
  await claimScope(fixture.context, {
    agentId: "visual", scope: "game/presentation", reason: "camera",
  });
  await assert.rejects(releaseScope(fixture.context, {
    agentId: "models", scope: "game/presentation",
  }), error => error.exitCode === EXIT.CONFLICT);
  assert.equal((await claimFiles(fixture.context)).length, 1);
  assert.equal((await releaseScope(fixture.context, {
    agentId: "visual", scope: "game/presentation",
  })).agent_id, "visual");
  assert.equal((await claimFiles(fixture.context)).length, 0);
});
test("owner-scoped close release cannot remove another agent claims", async t => {
  const fixture = await fixtureFor(t);
  for (const scope of ["game/presentation", "contract:tank-registration-v1"]) {
    await claimScope(fixture.context, { agentId: "visual", scope, reason: "work" });
  }
  await claimScope(fixture.context, {
    agentId: "models", scope: "game/models", reason: "mesh",
  });
  const released = await releaseOwnedClaims(fixture.context, "visual");
  assert.equal(released.length, 2);
  assert.deepEqual((await claims(fixture.context)).map(record => record.agent_id), ["models"]);
});
test("orchestrator force-releases only a stale foreign claim and audits first", async t => {
  const fixture = await fixtureFor(t, [
    { agentId: "visual" }, { agentId: "ops", role: "orchestrator" },
  ]);
  await claimScope(fixture.context, {
    agentId: "visual", scope: "game/presentation", reason: "camera", leaseSeconds: 1,
  });
  fixture.clock.advance(1_001);
  const released = await forceReleaseStaleScope(fixture.context, {
    agentId: "ops", ownerAgent: "visual", scope: "game/presentation",
  });
  assert.equal(released.agent_id, "visual");
  assert.equal((await claimFiles(fixture.context)).length, 0);
  const audits = await auditFiles(fixture.context);
  assert.equal(audits.length, 1);
  const auditPath = path.join(fixture.context.paths.quarantine, audits[0]);
  const before = await readFile(auditPath, "utf8");
  assert.equal(JSON.parse(before).action, "force_release_stale_claim");
  await assert.rejects(forceReleaseStaleScope(fixture.context, {
    agentId: "ops", ownerAgent: "visual", scope: "game/presentation",
  }), error => error.exitCode === EXIT.CONFLICT);
  assert.equal(await readFile(auditPath, "utf8"), before);
});
test("force release rejects non-orchestrators and active claims without audit", async t => {
  const fixture = await fixtureFor(t, [
    { agentId: "visual" }, { agentId: "models" },
    { agentId: "ops", role: "orchestrator" },
  ]);
  await claimScope(fixture.context, {
    agentId: "visual", scope: "game/presentation", reason: "camera",
  });
  for (const agentId of ["models", "ops"]) {
    await assert.rejects(forceReleaseStaleScope(fixture.context, {
      agentId, ownerAgent: "visual", scope: "game/presentation",
    }), error => error.exitCode === EXIT.CONFLICT);
  }
  assert.equal((await claimFiles(fixture.context)).length, 1);
  assert.deepEqual(await auditFiles(fixture.context), []);
});
test("a pre-existing atomic mkdir lock rejects contention without changing owner", async t => {
  const fixture = await fixtureFor(t);
  await seedLock(fixture.context);
  const before = await readFile(lockOwnerFile(fixture.context), "utf8");
  await assert.rejects(claimScope(fixture.context, {
    agentId: "visual", scope: "game/presentation", reason: "camera",
  }), error => error.exitCode === EXIT.CONFLICT);
  assert.equal(await readFile(lockOwnerFile(fixture.context), "utf8"), before);
});
test("published owner cleanup preserves the original acquisition error", async t => {
  const fixture = await fixtureFor(t);
  const failure = new Error("fsync cleanup failed after publish");
  const context = {
    ...fixture.context,
    writeClaimLockOwner: async (...args) => {
      await writeJsonAtomic(...args);
      throw failure;
    },
  };
  await assert.rejects(claimScope(context, {
    agentId: "visual", scope: "game/presentation", reason: "camera",
  }), error => error === failure);
  assert.equal(await pathExists(lockDir(context)), false);
  assert.deepEqual(await claimFiles(context), []);
});
test("repair never removes a live lock or a dead lock at most sixty seconds old", async t => {
  for (const item of [
    { live: true, age: 60_001 },
    { live: false, age: 60_000 },
  ]) {
    const fixture = await fixtureFor(t);
    const acquiredAt = new Date(fixture.context.now().getTime() - item.age).toISOString();
    await seedLock(fixture.context, { acquiredAt });
    const context = { ...fixture.context, pidIsAlive: () => item.live };
    assert.equal(await repairStaleClaimLock(context), false);
    assert.equal(await pathExists(lockDir(context)), true);
    assert.deepEqual(await auditFiles(context), []);
  }
});
test("repair audits a dead lock older than sixty seconds before removing it", async t => {
  const fixture = await fixtureFor(t);
  await seedLock(fixture.context, {
    acquiredAt: new Date(fixture.context.now().getTime() - 60_001).toISOString(),
  });
  assert.equal(await repairStaleClaimLock(fixture.context), true);
  assert.equal(await pathExists(lockDir(fixture.context)), false);
  const audits = await auditFiles(fixture.context);
  assert.equal(audits.length, 1);
  assert.equal(JSON.parse(await readFile(
    path.join(fixture.context.paths.quarantine, audits[0]), "utf8",
  )).action, "repair_stale_claim_lock");
});
test("delayed second repair cannot quarantine a replacement live lock", {
  timeout: 1_000,
}, async t => {
  const fixture = await fixtureFor(t);
  await seedLock(fixture.context, {
    acquiredAt: new Date(fixture.context.now().getTime() - 60_001).toISOString(),
  });
  const secondAtRename = deferred(), firstRenamed = deferred(), releaseSecond = deferred();
  let renameCount = 0;
  const context = { ...fixture.context, renameClaimLock: async (source, destination) => {
    renameCount += 1;
    if (renameCount === 1) {
      await secondAtRename.promise;
      await rename(source, destination);
      firstRenamed.resolve();
      return;
    }
    secondAtRename.resolve();
    await releaseSecond.promise;
    await rename(source, destination);
  } };
  const repairs = [repairStaleClaimLock(context), repairStaleClaimLock(context)];
  await firstRenamed.promise;
  const replacement = await seedLock(context, { agent: "models", pid: 9999 });
  releaseSecond.resolve();
  assert.deepEqual((await Promise.all(repairs)).sort(), [false, true]);
  assert.deepEqual(JSON.parse(await readFile(lockOwnerFile(context), "utf8")), replacement);
  const staleDirs = (await readdir(context.paths.quarantine, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && entry.name.startsWith("claims-lock-stale-"));
  assert.equal(staleDirs.length, 1);
  assert.equal(JSON.parse(await readFile(path.join(
    context.paths.quarantine, staleDirs[0].name, "owner.json",
  ), "utf8")).owner_agent, "visual");
});
test("failed repair audit leaves the stale lock in place", async t => {
  const fixture = await fixtureFor(t);
  await seedLock(fixture.context, {
    acquiredAt: new Date(fixture.context.now().getTime() - 60_001).toISOString(),
  });
  await rm(fixture.context.paths.quarantine, { recursive: true });
  await writeFile(fixture.context.paths.quarantine, "not a directory");
  await assert.rejects(repairStaleClaimLock(fixture.context));
  assert.equal(await pathExists(lockDir(fixture.context)), true);
  assert.equal(await pathExists(lockOwnerFile(fixture.context)), true);
});
test("failed immutable audit leaves the stale claim in place", async t => {
  const fixture = await fixtureFor(t, [
    { agentId: "visual" }, { agentId: "ops", role: "orchestrator" },
  ]);
  await claimScope(fixture.context, {
    agentId: "visual", scope: "game/presentation", reason: "camera", leaseSeconds: 1,
  });
  fixture.clock.advance(1_001);
  await rm(fixture.context.paths.quarantine, { recursive: true });
  await writeFile(fixture.context.paths.quarantine, "not a directory");
  await assert.rejects(forceReleaseStaleScope(fixture.context, {
    agentId: "ops", ownerAgent: "visual", scope: "game/presentation",
  }));
  assert.equal((await claimFiles(fixture.context)).length, 1);
});
