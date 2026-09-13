import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { STORE_VERSION } from "@agents-can-communicate/storage-filesystem";
import { installManaged } from "../src/managed-runtime/install.mjs";
import { readControl } from "../src/managed-runtime/state.mjs";

const serviceFailure = { adapterId: "codex", stage: "service-setup", error: "download failed" };
const integrationFailure = { adapterId: "claude_code", error: "config write failed" };
const cases = [
  { name: "completed integration with a service failure remains usable", applied: true,
    failed: [serviceFailure], phase: "ready" },
  { name: "a service failure without a completed integration keeps the fence", applied: false,
    failed: [serviceFailure], phase: "activating" },
  { name: "an integration failure keeps the fence", applied: false,
    failed: [integrationFailure], phase: "activating" },
  { name: "mixed service and integration failures keep the fence", applied: true,
    failed: [serviceFailure, integrationFailure], phase: "activating" },
];

for (const entry of cases) test(entry.name, async t => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "acc-install-failure-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const source = path.join(base, "source"), dataHome = path.join(base, "data");
  const managerRoot = path.join(dataHome, "acc", "runtime");
  await mkdir(path.join(source, "bin"), { recursive: true });
  await writeFile(path.join(source, "package.json"), JSON.stringify({ name: "agents-can-communicate",
    version: "0.5.6", files: ["bin/"], bundleDependencies: [],
    accManagedUpdateProtocol: 2, accStoreVersion: STORE_VERSION }));
  await writeFile(path.join(source, "bin/acc.mjs"),
    'if (process.argv[2] === "version") console.log(JSON.stringify({ data: { version: "0.5.6" } }));\n');
  const expected = { operations: [{ adapterId: "codex", applied: entry.applied }], failed: entry.failed };
  const result = await installManaged({ packageRoot: source, managerRoot, dataHome, home: base,
    targets: ["codex", "claude_code"], env: { HOME: base, ACC_NO_UPDATE_CHECK: "1" }, cwd: base,
    apply: async () => expected });
  assert.deepEqual(result, expected, "installation errors still reach the caller");
  const control = await readControl(managerRoot);
  assert.equal(control.phase, entry.phase);
  assert.equal(control.pending === null, entry.phase === "ready");
  if (entry.phase === "activating") assert.match(control.notice, /Integration refresh is incomplete/);
});
