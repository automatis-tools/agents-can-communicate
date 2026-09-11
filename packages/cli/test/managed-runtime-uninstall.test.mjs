// Final review, Finding 5: `retireManagedHolds` had direct coverage, but the
// line that wires it into the product - `uninstallManaged`'s
// `targets.length === 0` gate - had none, and the design spec's own acceptance
// item (uninstall with a live session, followed by install and update with no
// remaining holds) was unimplemented. This drives the real command path:
// installManaged stages and publishes a generation, a live session publishes
// the holds a real one would, uninstallManaged retires them, and a second
// install and activation complete without any process exiting.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { STORE_VERSION } from "@agents-can-communicate/storage-filesystem";

import { activatePending } from "../src/managed-runtime/activation.mjs";
import { installManaged, uninstallManaged } from "../src/managed-runtime/install.mjs";
import { writePin } from "../src/managed-runtime/pins.mjs";
import { readControl, writeControl } from "../src/managed-runtime/state.mjs";

// A source package in exactly the shape stageOwnGeneration accepts, verified by
// a real spawned subprocess the way every managed install verifies its
// candidate: `acc <root>/bin/acc.mjs version --json` must report this version.
async function sourcePackage(base, version) {
  const source = path.join(base, "source");
  await mkdir(path.join(source, "bin"), { recursive: true });
  await writeFile(path.join(source, "package.json"), JSON.stringify({
    name: "agents-can-communicate", version, files: ["bin/"], bundleDependencies: [],
    accManagedUpdateProtocol: 2, accStoreVersion: STORE_VERSION }));
  await writeFile(path.join(source, "bin", "acc.mjs"),
    "if (process.argv[2] === 'version' && process.argv[3] === '--json') "
    + `console.log(JSON.stringify({ data: { version: ${JSON.stringify(version)} } }));\n`);
  return source;
}

const installed = adapterId => ({ operations: [{ adapterId, applied: true, summary: [] }], failed: [] });

test("uninstall retires a live session's holds, and the next install and update need no process to exit", async t => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "acc-uninstall-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dataHome = path.join(base, "data");
  const managerRoot = path.join(dataHome, "acc", "runtime");
  const env = { HOME: base, ACC_NO_UPDATE_CHECK: "1" };
  const source = await sourcePackage(base, "0.5.0");
  const install = () => installManaged({ packageRoot: source, managerRoot, dataHome, home: base,
    targets: ["codex"], env, cwd: base, apply: async () => installed("codex") });

  await install();
  const active = (await readControl(managerRoot)).active;
  assert.equal(active.version, "0.5.0");
  assert.equal(active.storeVersion, STORE_VERSION);

  // The live session: a native binding record naming the generation this
  // install published, and the session pin that goes with it. The binding
  // declares no store contract, which is the shape every record written before
  // this release has, so it is an unknown contract and blocks activation. Its
  // PID is this test process, so no confirmed-death sweep can reap it.
  const bindings = path.join(dataHome, "acc", "workspaces", "project", "bindings");
  await mkdir(bindings, { recursive: true });
  await writeFile(path.join(bindings, "session.json"), JSON.stringify({ schemaVersion: 1,
    harnessSessionId: "live-session", accSessionId: "session_live", generation: "generation_live",
    clientVersion: "2.1.267", platform: "darwin-arm64", clientPid: process.pid,
    runtimeRoot: active.root }));
  await writePin({ root: managerRoot, harnessSessionId: "live-session", runtimeRoot: active.root,
    version: "0.5.0", storeVersion: STORE_VERSION, clientPid: process.pid });

  // An update offered now has to wait: the binding's contract is unknown.
  // This is the control for everything below - if the retirement the uninstall
  // performs did nothing, the second attempt would answer exactly this way.
  const next = path.join(managerRoot, "generations", "0.6.0-next");
  await mkdir(next, { recursive: true });
  const pending = { version: "0.6.0", root: next, storeVersion: STORE_VERSION };
  const refresh = async () => async () => ({ failed: [] });
  await writeControl(managerRoot, { ...await readControl(managerRoot), pending });
  const blocked = await activatePending(managerRoot, { prepare: refresh, env,
    pidIsAlive: () => true });
  assert.equal(blocked.activated, false);
  assert.equal(blocked.reason, "processes_active");

  // The product path, not retireManagedHolds directly: uninstalling the only
  // target empties control.targets, which is what opens the retirement gate.
  const removal = await uninstallManaged({ managerRoot,
    apply: async () => installed("codex") });
  assert.deepEqual(removal.failed, []);
  const afterRemoval = await readControl(managerRoot);
  assert.deepEqual(afterRemoval.targets, []);
  assert.equal(afterRemoval.pending, null);
  assert.deepEqual(await readdir(bindings), []);
  assert.deepEqual(await readdir(path.join(managerRoot, "pins")), []);

  // Install and update again, with the same session still running and never
  // signalled. Nothing is left holding the previous generation, so the
  // activation that waited above now completes.
  await install();
  assert.deepEqual((await readControl(managerRoot)).targets, ["codex"]);
  await writeControl(managerRoot, { ...await readControl(managerRoot), pending });
  const activated = await activatePending(managerRoot, { prepare: refresh, env,
    pidIsAlive: () => true });
  assert.equal(activated.activated, true);
  assert.equal(activated.version, "0.6.0");
  assert.equal((await readControl(managerRoot)).active.version, "0.6.0");
});

// The gate is `targets.length === 0`, so removing one of several adapters
// retires nothing. Binding records name the generation that published them and
// no adapter id, so there is no way to retire only the holds belonging to the
// adapter being removed - and retiring all of them would strip a client that
// is still installed of its coordination. Partial removal therefore keeps
// every hold, and the spec now says so.
test("uninstalling one of several targets retires nothing", async t => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "acc-uninstall-partial-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dataHome = path.join(base, "data");
  const managerRoot = path.join(dataHome, "acc", "runtime");
  const env = { HOME: base, ACC_NO_UPDATE_CHECK: "1" };
  const source = await sourcePackage(base, "0.5.0");
  await installManaged({ packageRoot: source, managerRoot, dataHome, home: base,
    targets: ["codex", "claude_code"], env, cwd: base,
    apply: async () => ({ operations: [{ adapterId: "codex", applied: true, summary: [] },
      { adapterId: "claude_code", applied: true, summary: [] }], failed: [] }) });
  const active = (await readControl(managerRoot)).active;

  const bindings = path.join(dataHome, "acc", "workspaces", "project", "bindings");
  await mkdir(bindings, { recursive: true });
  await writeFile(path.join(bindings, "session.json"), JSON.stringify({ schemaVersion: 1,
    harnessSessionId: "live-session", accSessionId: "session_live", generation: "generation_live",
    clientVersion: "2.1.267", platform: "darwin-arm64", clientPid: process.pid,
    runtimeRoot: active.root }));
  await writePin({ root: managerRoot, harnessSessionId: "live-session", runtimeRoot: active.root,
    version: "0.5.0", storeVersion: STORE_VERSION, clientPid: process.pid });

  await uninstallManaged({ managerRoot, apply: async () => installed("codex") });
  assert.deepEqual((await readControl(managerRoot)).targets, ["claude_code"]);
  assert.deepEqual(await readdir(bindings), ["session.json"]);
  assert.equal((await readdir(path.join(managerRoot, "pins"))).length, 1);

  // And removing the last one does retire them, which is what proves the line
  // above came from the gate rather than from retirement being unreachable.
  await uninstallManaged({ managerRoot, apply: async () => installed("claude_code") });
  assert.deepEqual((await readControl(managerRoot)).targets, []);
  assert.deepEqual(await readdir(bindings), []);
  assert.deepEqual(await readdir(path.join(managerRoot, "pins")), []);
});
