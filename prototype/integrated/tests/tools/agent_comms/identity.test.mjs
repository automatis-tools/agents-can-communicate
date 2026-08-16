import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { EXIT } from "../../../tools/agents/lib/errors.mjs";
import { createBusPaths, ensureBusLayout } from "../../../tools/agents/lib/paths.mjs";
import { validatePresence } from "../../../tools/agents/lib/schema.mjs";
import {
  createBusFixture,
  createGitWorktreeFixture,
  seedPresence,
} from "./helpers.mjs";
import {
  closeAgent,
  initBus,
  registerAgent,
  requireOpenAgent,
} from "../../../tools/agents/lib/identity.mjs";
import { acquireWatcherOwnership, writePresenceIfWatcherOwner }
  from "../../../tools/agents/lib/watcher-ownership.mjs";

const HEAD = "a".repeat(40);

function registration(agentId, worktree, overrides = {}) {
  return {
    agentId,
    role: agentId,
    task: "M2.7",
    worktree,
    ownership: ["tools/agents"],
    client: "codex",
    ...overrides,
  };
}

function contextFor(fixture, options = {}) {
  return {
    paths: fixture.paths,
    now: fixture.clock.now,
    pidIsAlive: options.pidIsAlive ?? (() => false),
    gitState: options.gitState ?? (async () => ({ branch: "m2/identity", head: HEAD })),
    releaseOwnedClaims: options.releaseOwnedClaims ?? (async () => {}),
  };
}

async function writeLivePresence(context, agentId, pid) {
  await seedPresence(context, { agentId, pid, status: "online" });
}

test("init records the canonical checkout identity exactly once", async t => {
  const fixture = await createGitWorktreeFixture();
  t.after(fixture.cleanup);
  const paths = createBusPaths(fixture.bus);
  const clock = { now: () => new Date("2026-08-14T18:00:00.000Z") };
  const context = {
    paths,
    now: clock.now,
    pidIsAlive: () => false,
    gitState: async () => ({ branch: "main", head: HEAD }),
    releaseOwnedClaims: async () => {},
  };
  const commonDir = await realpath(path.join(fixture.main, ".git"));
  const expected = {
    schema_version: 1,
    protocol_version: 1,
    checkout_id: createHash("sha256").update(commonDir).digest("hex"),
    checkout_root: fixture.main,
    initialized_at: "2026-08-14T18:00:00.000Z",
  };

  assert.deepEqual(await initBus(context), expected);
  assert.deepEqual(JSON.parse(await readFile(paths.protocol, "utf8")), expected);
});

test("compatible init is idempotent", async t => {
  const fixture = await createGitWorktreeFixture();
  t.after(fixture.cleanup);
  const paths = createBusPaths(fixture.bus);
  let timestamp = "2026-08-14T18:00:00.000Z";
  const context = {
    paths,
    now: () => new Date(timestamp),
    pidIsAlive: () => false,
    gitState: async () => ({ branch: "main", head: HEAD }),
    releaseOwnedClaims: async () => {},
  };

  const first = await initBus(context);
  timestamp = "2026-08-14T18:01:00.000Z";
  assert.deepEqual(await initBus(context), first);
});

test("init refuses to replace an unknown protocol version", async t => {
  const fixture = await createGitWorktreeFixture();
  t.after(fixture.cleanup);
  const paths = createBusPaths(fixture.bus);
  await ensureBusLayout(paths);
  const incompatible = {
    schema_version: 1,
    protocol_version: 2,
    checkout_id: "b".repeat(64),
    checkout_root: fixture.main,
    initialized_at: "2026-08-14T18:00:00.000Z",
  };
  await writeFile(paths.protocol, `${JSON.stringify(incompatible)}\n`, "utf8");
  const context = {
    paths,
    now: () => new Date("2026-08-14T18:01:00.000Z"),
    pidIsAlive: () => false,
    gitState: async () => ({ branch: "main", head: HEAD }),
    releaseOwnedClaims: async () => {},
  };

  await assert.rejects(initBus(context), error => error.exitCode === EXIT.DATA);
  assert.deepEqual(JSON.parse(await readFile(paths.protocol, "utf8")), incompatible);
});

test("registration captures the Git branch and HEAD", async t => {
  const fixture = await createBusFixture();
  t.after(fixture.cleanup);
  const context = contextFor(fixture, {
    gitState: async cwd => ({ branch: `branch-for-${path.basename(cwd)}`, head: HEAD }),
  });

  const record = await registerAgent(context, registration("visual", "/tmp/visual-worktree"));

  assert.deepEqual(record, {
    schema_version: 1,
    agent_id: "visual",
    role: "visual",
    task: "M2.7",
    worktree: "/tmp/visual-worktree",
    branch: "branch-for-visual-worktree",
    head: HEAD,
    ownership: ["tools/agents"],
    client: "codex",
    status: "open",
    registered_at: "2026-08-14T18:00:00.000Z",
    updated_at: "2026-08-14T18:00:00.000Z",
  });
});

test("a live duplicate id is rejected", async t => {
  const fixture = await createBusFixture();
  t.after(fixture.cleanup);
  const context = contextFor(fixture, { pidIsAlive: pid => pid === 1234 });
  await registerAgent(context, registration("visual", "/tmp/worktree-a"));
  await writeLivePresence(context, "visual", 1234);

  await assert.rejects(
    registerAgent(context, registration("visual", "/tmp/worktree-b")),
    error => error.exitCode === EXIT.CONFLICT,
  );
});

test("stale open registration still requires an explicit resume", async t => {
  const fixture = await createBusFixture();
  t.after(fixture.cleanup);
  const context = contextFor(fixture, { pidIsAlive: () => true });
  await registerAgent(context, registration("visual", "/tmp/worktree-a"));
  await writeLivePresence(context, "visual", 1234);
  fixture.clock.advance(45_001);

  await assert.rejects(registerAgent(context, registration("visual", "/tmp/worktree-b")),
    error => error.exitCode === EXIT.CONFLICT);
});

test("resume requires the same worktree and task", async t => {
  const fixture = await createBusFixture();
  t.after(fixture.cleanup);
  const context = contextFor(fixture);
  const first = await registerAgent(context, registration("models", "/tmp/worktree-a"));
  const resumed = await registerAgent(context, { ...first, resume: true });

  assert.equal(resumed.agent_id, "models");
  await assert.rejects(
    registerAgent(context, { ...first, task: "M2.8", resume: true }),
    error => error.exitCode === EXIT.CONFLICT,
  );
  await assert.rejects(
    registerAgent(context, { ...first, worktree: "/tmp/worktree-b", resume: true }),
    error => error.exitCode === EXIT.CONFLICT,
  );
});

test("requireOpenAgent rejects missing and closed registrations", async t => {
  const fixture = await createBusFixture();
  t.after(fixture.cleanup);
  const context = contextFor(fixture);

  await assert.rejects(
    requireOpenAgent(context, "missing"),
    error => error.exitCode === EXIT.CONFLICT,
  );
  await registerAgent(context, registration("visual", "/tmp/worktree-a"));
  await closeAgent(context, "visual");
  await assert.rejects(
    requireOpenAgent(context, "visual"),
    error => error.exitCode === EXIT.CONFLICT,
  );
});

test("requireOpenAgent returns a strict open registry record", async t => {
  const fixture = await createBusFixture();
  t.after(fixture.cleanup);
  const context = contextFor(fixture);
  const registered = await registerAgent(context, registration("visual", "/tmp/worktree-a"));

  assert.deepEqual(await requireOpenAgent(context, "visual"), registered);
});

test("requireOpenAgent accepts stale and offline open registrations", async t => {
  const fixture = await createBusFixture();
  t.after(fixture.cleanup);
  const context = contextFor(fixture, { pidIsAlive: () => true });
  const cases = [
    {
      agentId: "visual",
      presence: { status: "online", heartbeatAt: "2026-08-14T17:59:14.999Z" },
    },
    {
      agentId: "models",
      presence: { status: "offline", heartbeatAt: "2026-08-14T18:00:00.000Z" },
    },
  ];

  for (const item of cases) {
    const registered = await registerAgent(
      context,
      registration(item.agentId, `/tmp/${item.agentId}-worktree`),
    );
    await seedPresence(context, { agentId: item.agentId, pid: 1234, ...item.presence });
    assert.deepEqual(await requireOpenAgent(context, item.agentId), registered);
  }
});

test("close refuses a live watcher and releases only the closed agent claims", async t => {
  const fixture = await createBusFixture();
  t.after(fixture.cleanup);
  const released = [];
  const context = contextFor(fixture, {
    pidIsAlive: pid => pid === 1234,
    releaseOwnedClaims: async agentId => { released.push(agentId); },
  });
  await registerAgent(context, registration("visual", "/tmp/worktree-a"));
  await registerAgent(context, registration("models", "/tmp/worktree-b"));
  const owner = await acquireWatcherOwnership(context, "visual", 1234);

  await assert.rejects(closeAgent(context, "visual"), error => error.exitCode === EXIT.CONFLICT);
  await writePresenceIfWatcherOwner(context, owner, "offline", true);
  const closed = await closeAgent(context, "visual");
  const presence = await readPresence(context, "visual");

  assert.equal(closed.status, "closed");
  assert.equal(closed.closed_at, "2026-08-14T18:00:00.000Z");
  assert.equal(presence.status, "offline");
  assert.deepEqual(released, ["visual"]);
});

async function readPresence(context, agentId) {
  return validatePresence(JSON.parse(await readFile(context.paths.presenceFile(agentId), "utf8")));
}
