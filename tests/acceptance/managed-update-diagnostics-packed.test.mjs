import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createPackedAcc } from "../helpers/packed-acc.mjs";
import { createUpdateRegistry } from "../helpers/update-registry.mjs";

test("installed doctor reports update recovery while workspace admission is fenced", async t => {
  const f = await createPackedAcc(t);
  await f.setClientVersions({ grok: "1.0.25" });
  await f.acc(["install", "--adapter", "grok"]);
  const file = path.join(f.dataHome, "acc/runtime/control.json");
  const control = JSON.parse(await readFile(file));
  await writeFile(file, JSON.stringify({ ...control, pending: control.active, phase: "activating" }));
  await writeFile(path.join(f.project, "acc.workspace.json"), "invalid workspace bytes");
  const doctor = await f.acc(["doctor"]);
  assert.equal(doctor.scope, "update");
  assert.equal(doctor.workspaceInspection, "unavailable_during_update");
  assert.equal(doctor.update.phase, "activating");
  assert.match(doctor.update.notice, /incomplete.*acc update/);
  assert.equal((await f.accError(["doctor", "--repair"])).code, 4);
  assert.equal((await f.accError(["status"])).code, 4);
  assert.equal((await readFile(file, "utf8")).includes('"phase":"activating"'), true);
});

test("installed doctor uses the newer management reader for pending maintenance", async t => {
  const f = await createPackedAcc(t);
  await f.setClientVersions({ grok: "1.0.25" });
  await f.acc(["install", "--adapter", "grok"]);
  const root = path.join(f.dataHome, "acc/runtime");
  const bindings = path.join(f.dataHome, "acc/workspaces/fixture/bindings");
  await mkdir(bindings, { recursive: true });
  await writeFile(path.join(bindings, "native.json"), JSON.stringify({ schemaVersion: 1, clientPid: process.pid }));
  const registry = await createUpdateRegistry(t, f);
  await f.acc(["update"], { ...f.env, ACC_NO_UPDATE_CHECK: "0", npm_config_registry: registry.url,
    npm_config_cache: path.join(f.root, "update-cache") });
  const control = JSON.parse(await readFile(path.join(root, "control.json")));
  assert.equal(control.pending.version, registry.version);
  await writeFile(path.join(root, "maintenance.json"), JSON.stringify({ schemaVersion: 1,
    id: "11111111-1111-4111-a111-111111111111", status: "waiting", target: control.pending,
    workerRoot: control.pending.root, recipe: "fixture", deadline: Date.now() + 10000,
    callerPid: process.pid, workerPid: process.pid, attempted: [], reasonCode: null,
    waiting: { reason: "service_busy", busyThreads: 2, queuedRequests: 1 },
    services: [{ adapterId: "codex", snapshot: { pid: process.pid, serviceId: "codex-app-server",
      cliVersion: "0.154.0", serverVersion: "0.153.4" } }] }));
  await writeFile(path.join(f.project, "acc.workspace.json"), "invalid workspace bytes");
  const doctor = await f.acc(["doctor"]);
  assert.equal(doctor.scope, "update");
  assert.equal(doctor.update.running, control.active.version);
  assert.equal(doctor.update.maintenance.status, "waiting");
  assert.match(doctor.update.notice, /2 active turns, 1 queued requests/);
});
