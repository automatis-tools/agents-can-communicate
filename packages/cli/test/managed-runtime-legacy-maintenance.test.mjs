import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { bridgeLegacyMaintenance as bridge } from "../src/managed-runtime/legacy-maintenance.mjs";

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-legacy-maintenance-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const active = { version: "0.4.2", root: path.join(root, "generations", "old") };
  const pending = { version: "0.4.4", root: path.join(root, "generations", "new") };
  const script = path.join(active.root, "bin", "acc-update-worker.mjs");
  await mkdir(path.dirname(script), { recursive: true }); await writeFile(script, "// installed legacy worker\n");
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = true; output.isTTY = true;
  t.after(() => { input.destroy(); output.destroy(); });
  let printed = ""; output.on("data", bytes => { printed += bytes; });
  const services = [{ adapterId: "codex", snapshot: { state: "ready", pid: 123,
    cliVersion: "0.153.4", serverVersion: "0.153.3", managedVersion: "0.153.4" } }];
  return { root, script, input, output, services, printed: () => printed,
    control: { active, pending, targets: ["codex"] } };
}

test("legacy worker handoff requires the actual active worker script and an eligible service", async t => {
  const f = await fixture(t);
  const ports = { argv: [process.execPath, f.script, f.root], input: f.input, output: f.output,
    inspect: async () => f.services, requestMaintenance: async () => assert.fail("a background worker cannot request consent") };
  await assert.rejects(bridge(f, ports), error => error.code === "ACC_LEGACY_MAINTENANCE_HANDOFF");
  assert.equal(await bridge(f, { ...ports, inspect: async () => [] }), null);
  const unrelated = path.join(f.root, "acc-update-worker.mjs"); await writeFile(unrelated, "// unrelated\n");
  assert.equal(await bridge(f, { ...ports, argv: [process.execPath, unrelated, f.root] }), null);
  assert.equal(f.printed(), "");
});

test("legacy interactive update asks through candidate ports and prints only scheduled status", async t => {
  const f = await fixture(t);
  const pending = bridge(f, { argv: [process.execPath, "acc", "update"], input: f.input, output: f.output,
    inspect: async () => f.services, requestMaintenance: async ({ root, control, options, runtime, services }) => {
      assert.equal(root, f.root); assert.equal(control, f.control);
      assert.equal(options.json, false); assert.equal(runtime.isInteractive(), true);
      assert.equal(runtime.packageRoot, f.control.pending.root); assert.equal(services, f.services);
      const confirmed = await runtime.confirm("Restart the selected service?", { input: runtime.input, output: runtime.output });
      return confirmed ? { data: { scheduled: true }, text: "Maintenance scheduled; waiting for this command to exit." } : null;
    } });
  pending.catch(() => {});
  for (let attempt = 0; attempt < 100 && !f.printed().includes("[y/N]"); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  f.input.write("yes\n");
  assert.equal((await pending).data.scheduled, true);
  assert.match(f.printed(), /Maintenance scheduled; waiting/);
  assert.doesNotMatch(f.printed(), /updated|complete/i);
});

test("protocol-two, noninteractive, and JSON calls never enter the legacy prompt", async t => {
  const f = await fixture(t);
  const blocked = async () => assert.fail("this invocation must not inspect or request legacy maintenance");
  const ports = { argv: [process.execPath, "acc", "update"], input: f.input, output: f.output,
    inspect: blocked, requestMaintenance: blocked };
  assert.equal(await bridge({ ...f, callerProtocol: 2 }, ports), null);
  assert.equal(await bridge(f, { ...ports, argv: [...ports.argv, "--json"] }), null);
  f.input.isTTY = false;
  assert.equal(await bridge(f, ports), null);
});

test("an approved recovery resumes before service inspection and releases a verified legacy worker", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, "maintenance.json"), JSON.stringify({ schemaVersion: 1, status: "recovery",
    id: "11111111-1111-1111-1111-111111111111", recipe: "fixture", deadline: Date.now() + 60_000,
    callerPid: process.pid, workerPid: null, workerRoot: f.control.pending.root,
    target: f.control.pending, attempted: ["codex"], services: f.services }));
  let resumed = 0;
  const ports = { argv: [process.execPath, f.script, f.root], input: f.input, output: f.output,
    inspect: async () => assert.fail("a stopped service must not hide approved recovery"),
    requestMaintenance: async ({ runtime }) => {
      assert.equal(runtime.packageRoot, f.control.pending.root); resumed++;
      return { data: { reason: "maintenance_pending" }, text: "Recovery scheduled." };
    } };
  await assert.rejects(bridge(f, ports), error => error.code === "ACC_LEGACY_MAINTENANCE_HANDOFF");
  const result = await bridge(f, { ...ports, argv: [process.execPath, "acc", "update"] });
  assert.equal(result.data.reason, "maintenance_pending");
  assert.equal(resumed, 2);
});
