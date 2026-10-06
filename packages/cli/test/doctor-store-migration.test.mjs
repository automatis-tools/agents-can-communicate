import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { EXIT, SCHEMA_VERSION } from "@agents-can-communicate/protocol";
import { openFilesystemStore } from "@agents-can-communicate/storage-filesystem";
import { main } from "../src/main.mjs";
import { parseArgs } from "../src/args.mjs";
import { discoverWorkspace } from "../src/workspace-discovery.mjs";
import { runtimePaths } from "../src/runtime-paths.mjs";
import { writeControl, writeManagedJson } from "../src/managed-runtime/state.mjs";
import { acquireRuntime } from "../src/managed-runtime/leases.mjs";
import { listActivationBlockers } from "../src/managed-runtime/activation.mjs";
import { createFakeClock, createFakeIds } from "../../../tests/helpers/memory-store.mjs";
import { exactMessage, EXACT_NOW as NOW } from "../../../tests/helpers/exact-transaction-contract.mjs";

async function fixture(t, managed = true) {
  const root = await mkdtemp(path.join(tmpdir(), "acc-doctor-migration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project"), home = path.join(root, "home"), dataHome = path.join(root, "data");
  for (const dir of [project, home, dataHome]) await mkdir(dir);
  const descriptor = await discoverWorkspace({ cwd: project, gitProbe: async () => null });
  const paths = runtimePaths({ dataHome, workspaceId: descriptor.id });
  const clock = createFakeClock(NOW), ids = createFakeIds();
  const store = await openFilesystemStore({ root: paths.root, workspaceId: descriptor.id, clock, ids });
  await store.transaction(tx => tx.put("message", "message_a", exactMessage({ workspaceId: descriptor.id })), { kinds: ["message"] });
  const identityFile = path.join(paths.root, "protocol.json");
  await writeFile(identityFile, JSON.stringify({ ...JSON.parse(await readFile(identityFile)), storeVersion: 6 }));
  const manager = path.join(dataHome, "acc", "runtime"), generation = path.join(manager, "generations", "old");
  const active = { root: generation, version: "0.9.0", storeVersion: 6 };
  const control = { schemaVersion: 1, active, pending: null, phase: "ready", auto: false,
    pin: null, checkedAt: null, home, targets: [], notice: null };
  if (managed) {
    await mkdir(generation, { recursive: true });
    await writeFile(path.join(generation, "package.json"), JSON.stringify({ name: "agents-can-communicate", version: "0.9.0", accStoreVersion: 6 }));
    await writeControl(manager, control);
  }
  const runtime = { cwd: project, dataHome, clock, ids, gitProbe: async () => null,
    env: { HOME: home, ACC_DATA_HOME: dataHome, ACC_NO_UPDATE_CHECK: "1" }, ...(managed ? { managerRoot: manager } : {}) };
  const run = async (args, extra = {}) => {
    let stdout = "", stderr = "";
    const output = name => ({ write(text, done) { if (name === "stdout") stdout += text; else stderr += text; done(); } });
    const code = await main([...args, "--cwd", project, "--json"],
      { ...runtime, ...extra, stdout: output("stdout"), stderr: output("stderr") });
    return { code, body: JSON.parse(stdout), stderr };
  };
  const native = async record => {
    const directory = path.join(paths.root, "bindings"); await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "native.json"), typeof record === "string" ? record : JSON.stringify(record));
  };
  const lease = async pid => {
    await mkdir(path.join(manager, "leases"), { recursive: true });
    await writeManagedJson(path.join(manager, "leases/lease_a.json"),
      { schemaVersion: 1, token: "lease_a", pid, kind: "acc-mcp", runtime: active, createdAt: NOW });
  };
  return { root, manager, control, runtime, run, paths, native, lease, identityFile };
}
const migrate = f => f.run(["doctor", "--migrate-store"], { managementOnly: true });

test("explicit migration parses and is separate from repair", () => {
  assert.equal(parseArgs(["doctor", "--migrate-store"]).options.migrateStore, true);
  assert.throws(() => parseArgs(["doctor", "--migrate-store", "--repair"]), { code: EXIT.USAGE });
});

test("migration dispatch locates v6 state without opening a v7 service", async t => {
  const f = await fixture(t), result = await migrate(f);
  assert.equal(result.code, EXIT.OK, JSON.stringify(result.body));
  assert.equal(result.body.data.migrated, true);
  assert.equal(result.body.data.fromVersion, 6);
  assert.equal(JSON.parse(await readFile(f.identityFile)).storeVersion, 7);
  assert.equal((await f.run(["status"], { managementOnly: true })).code, EXIT.DATA);
});

test("an unmanaged install uses the same data-home admission fence", async t => {
  const f = await fixture(t, false), result = await f.run(["doctor", "--migrate-store"]);
  assert.equal(result.code, EXIT.OK, JSON.stringify(result.body));
  assert.equal(result.body.data.toVersion, 7);
});

test("a cache fault is a separate diagnostic after a recorded CLI send", async t => {
  const f = await fixture(t, false);
  assert.equal((await f.run(["doctor", "--migrate-store"])).code, EXIT.OK);
  const sender = await f.run(["attach", "--participant", "sender", "--harness", "cli"]);
  assert.equal(sender.code, EXIT.OK);
  assert.equal((await f.run(["attach", "--participant", "peer", "--harness", "cli"])).code, EXIT.OK);
  const outside = path.join(f.root, "outside"); await mkdir(outside);
  await rm(path.join(f.paths.root, "indexes"), { recursive: true });
  await symlink(outside, path.join(f.paths.root, "indexes"), "junction");
  const result = await f.run(["message", "--to", "peer", "--subject", "Cache failed", "--body", "Still recorded",
    "--session", sender.body.data.sessionId, "--generation", sender.body.data.generation]);
  assert.equal(result.code, EXIT.OK, JSON.stringify(result.body));
  assert.equal(result.body.data.message.body, "Still recorded");
  assert.match(result.stderr, /transaction index unavailable/);
});

for (const hold of ["lease", "native-own-pid", "unknown-contract", "unknown-pid"]) {
  test(`different or unknown holders refuse migration: ${hold}`, async t => {
    const f = await fixture(t), before = await readFile(f.identityFile);
    if (hold === "lease") await f.lease(process.ppid);
    else await f.native({ schemaVersion: 1, harnessSessionId: "claude_fixture",
      clientPid: hold === "unknown-pid" ? null : process.pid, storeVersion: hold === "unknown-contract" ? null : 6 });
    const result = await migrate(f);
    assert.equal(result.code, EXIT.CONFLICT, JSON.stringify(result.body));
    assert.deepEqual(await readFile(f.identityFile), before);
  });
}

test("only the command's own lease is ignored, and admission requires ready control", async t => {
  const f = await fixture(t); await f.lease(process.pid);
  await writeControl(f.manager, { ...f.control, phase: "activating" });
  assert.equal((await migrate(f)).code, EXIT.CONFLICT);
  assert.equal(JSON.parse(await readFile(f.identityFile)).storeVersion, 6);
  await writeControl(f.manager, f.control);
  assert.equal((await migrate(f)).code, EXIT.OK);
});

test("unsafe or unreadable holds refuse with DATA before identity changes", async t => {
  const f = await fixture(t), before = await readFile(f.identityFile);
  await f.native("not valid JSON");
  assert.equal((await migrate(f)).code, EXIT.DATA);
  assert.deepEqual(await readFile(f.identityFile), before);
});

test("an unsafe workspace junction refuses migration without switching identity", async t => {
  const f = await fixture(t), before = await readFile(f.identityFile);
  await symlink(f.paths.root, path.join(path.dirname(f.paths.root), "workspace_link"), "junction");
  assert.equal((await migrate(f)).code, EXIT.DATA);
  assert.deepEqual(await readFile(f.identityFile), before);
});

for (const harness of ["mcp", "cli"]) {
  test(`legacy MCP continuity requires a validated owner: ${harness}`, async t => {
    const f = await fixture(t), identity = JSON.parse(await readFile(f.identityFile));
    const owner = { schemaVersion: SCHEMA_VERSION, workspaceId: identity.workspaceId,
      sessionId: "session_mcp", participantId: "participant_a", generation: "generation_mcp", harness,
      // Open and heartbeating: a quiet or closed owner without a pid stops holding on its own
      // (#273), and this case is about the continuity exemption, not presence.
      state: "open", parentSessionId: null, checkoutRoot: null, branch: null, pid: null,
      enforcement: "advisory", lifecycle: "manual", heartbeatCadenceMs: 30_000, startedAt: NOW,
      heartbeatAt: new Date().toISOString() };
    await mkdir(path.join(f.paths.state, "session"), { recursive: true });
    await writeFile(path.join(f.paths.state, "session/session_mcp.json"), JSON.stringify({
      kind: "session", id: "session_mcp", generation: "generation_envelope", record: owner }));
    const nativeId = `mcp:participant_a:${identity.workspaceId}`;
    const bindings = path.join(f.paths.root, "bindings"); await mkdir(bindings, { recursive: true });
    await writeFile(path.join(bindings, createHash("sha256").update(nativeId).digest("hex").slice(0, 32) + ".json"),
      JSON.stringify({ schemaVersion: 1, harnessSessionId: nativeId, accSessionId: "session_mcp", generation: "generation_mcp" }));
    if (harness === "mcp") assert.deepEqual(await listActivationBlockers(f.manager, { incomingStoreVersion: 7 }), [],
      "inactive legacy MCP continuity must not become an unknown native hold during a later activation");
    const result = await migrate(f);
    assert.equal(result.code, harness === "mcp" ? EXIT.OK : EXIT.CONFLICT, JSON.stringify(result.body));
    assert.equal(JSON.parse(await readFile(f.identityFile)).storeVersion, harness === "mcp" ? 7 : 6);
  });
}

test("admission stays fenced through workspace migration", async t => {
  const f = await fixture(t);
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const migration = f.run(["doctor", "--migrate-store"], { managementOnly: true,
    storeMigrationFailAt: async phase => {
      if (phase === "before-store-version-switch") { entered(); await gate; }
    } });
  // Missing dispatch fails before the gate, rather than hanging the RED run.
  await Promise.race([started, migration.then(result => {
    assert.equal(result.code, EXIT.OK, JSON.stringify(result.body));
  })]);
  let result;
  try {
    await assert.rejects(acquireRuntime(f.manager), /manager lock held/);
    assert.equal(JSON.parse(await readFile(f.identityFile)).storeVersion, 6);
  } finally { release(); result = await migration; }
  assert.equal(result.code, EXIT.OK);
  assert.equal((await acquireRuntime(f.manager)).runtime.storeVersion, 6,
    "migration does not install or activate another release");
});

// Plain doctor called a contract-6 store's identity unreadable and the store
// ambiguous, and named no migration (2026-10-06).
test("plain doctor names the migration for an older store instead of calling it unreadable", async t => {
  const f = await fixture(t);
  // Plain doctor resolves the platform's data directory, which on Windows is
  // LOCALAPPDATA - present on every real Windows account, absent from this fixture.
  const local = path.join(f.root, "home", "AppData", "Local");

  const result = await f.run(["doctor"], { env: { ...f.runtime.env, LOCALAPPDATA: local, USERPROFILE: path.join(f.root, "home") } });

  assert.equal(result.code, EXIT.DATA);
  assert.match(result.body.error.message, /acc doctor --migrate-store/);
  assert.doesNotMatch(result.body.error.message, /ambiguous|unreadable/);
  assert.equal(result.body.error.details.reasonCode, "store_migration_required");
});
