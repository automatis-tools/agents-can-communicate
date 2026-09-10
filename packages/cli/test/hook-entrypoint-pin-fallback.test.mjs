// Exercises the real `bin/entrypoints/acc-hook.mjs` `main()`, not just
// `resolvePinnedEntrypoint` in isolation: proves the hook actually delegates
// end to end, and - the rule that outranks the feature - proves a pinned
// generation that exists on disk but will not import or run still leaves the
// client with a normal, non-throwing exit rather than an error.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { writePin } from "../src/managed-runtime/pins.mjs";
import { main } from "../../../bin/entrypoints/acc-hook.mjs";

async function withArgv(args, fn) {
  const original = process.argv;
  process.argv = [process.execPath, "acc-hook", ...args];
  try { return await fn(); } finally { process.argv = original; }
}

// The real local hook path this falls back to resolves a data home from the
// environment; point it at a scratch directory so a test never touches a
// real installation's runtime state.
async function withDataHome(fn) {
  const dataHome = await mkdtemp(path.join(tmpdir(), "acc-hook-datahome-"));
  const original = process.env.ACC_DATA_HOME;
  process.env.ACC_DATA_HOME = dataHome;
  try { return await fn(dataHome); }
  finally {
    if (original === undefined) delete process.env.ACC_DATA_HOME;
    else process.env.ACC_DATA_HOME = original;
    await rm(dataHome, { recursive: true, force: true });
  }
}

test("a pinned session's hook runs the pinned generation's own entrypoint", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "acc-hook-pin-"));
  const managerRoot = path.join(root, "runtime");
  const pinned = path.join(managerRoot, "generations", "0.4.2-pinned");
  const active = path.join(managerRoot, "generations", "0.4.4-active");
  const marker = path.join(root, "delegated.json");
  await mkdir(path.join(pinned, "bin", "entrypoints"), { recursive: true });
  await writeFile(path.join(pinned, "bin", "entrypoints", "acc-hook.mjs"),
    "import { writeFile } from 'node:fs/promises';\n"
    + `export async function main(args) {\n`
    + `  await writeFile(${JSON.stringify(marker)}, JSON.stringify(args));\n`
    + "  process.exitCode = 0;\n"
    + "}\n");
  await writePin({ root: managerRoot, harnessSessionId: "session-pinned", runtimeRoot: pinned,
    version: "0.4.2", storeVersion: 6, clientPid: process.pid });

  const payload = { hook_event_name: "Notification", session_id: "session-pinned", cwd: root };
  await withArgv(["claude_code", "Notification"],
    () => main({ managerRoot, packageRoot: active, payload }));

  const written = JSON.parse(await readFile(marker, "utf8"));
  assert.equal(written.packageRoot, pinned);
  assert.equal(written.managerRoot, managerRoot);
  assert.deepEqual(written.payload, payload);
  assert.equal(process.exitCode, 0);
  process.exitCode = 0;
});

test("a pinned generation that will not import falls back to the active generation without failing the client", async () => {
  await withDataHome(async () => {
    const root = await mkdtemp(path.join(tmpdir(), "acc-hook-pin-broken-"));
    const managerRoot = path.join(root, "runtime");
    const pinned = path.join(managerRoot, "generations", "0.4.2-broken");
    const active = path.join(managerRoot, "generations", "0.4.4-active");
    await mkdir(path.join(pinned, "bin", "entrypoints"), { recursive: true });
    // A syntax error, not a thrown Error: proves the failure is caught around
    // the dynamic `import()` itself, not only around calling `main`.
    await writeFile(path.join(pinned, "bin", "entrypoints", "acc-hook.mjs"), "export const main = (\n");
    await writePin({ root: managerRoot, harnessSessionId: "session-broken", runtimeRoot: pinned,
      version: "0.4.2", storeVersion: 6, clientPid: process.pid });

    const payload = { hook_event_name: "Notification", session_id: "session-broken", cwd: root };
    process.exitCode = undefined;
    await withArgv(["claude_code", "Notification"],
      () => main({ managerRoot, packageRoot: active, payload }));

    // No throw reached the caller, and the process still exits the way a
    // hook always does when it lets the client proceed.
    assert.equal(process.exitCode, 0);
    process.exitCode = 0;
  });
});

test("a pinned generation whose entrypoint imports but whose main throws also falls back", async () => {
  await withDataHome(async () => {
    const root = await mkdtemp(path.join(tmpdir(), "acc-hook-pin-throws-"));
    const managerRoot = path.join(root, "runtime");
    const pinned = path.join(managerRoot, "generations", "0.4.2-throws");
    const active = path.join(managerRoot, "generations", "0.4.4-active");
    await mkdir(path.join(pinned, "bin", "entrypoints"), { recursive: true });
    await writeFile(path.join(pinned, "bin", "entrypoints", "acc-hook.mjs"),
      "export async function main() { throw new Error('pinned generation is broken'); }\n");
    await writePin({ root: managerRoot, harnessSessionId: "session-throws", runtimeRoot: pinned,
      version: "0.4.2", storeVersion: 6, clientPid: process.pid });

    const payload = { hook_event_name: "Notification", session_id: "session-throws", cwd: root };
    process.exitCode = undefined;
    await withArgv(["claude_code", "Notification"],
      () => main({ managerRoot, packageRoot: active, payload }));

    assert.equal(process.exitCode, 0);
    process.exitCode = 0;
  });
});

test("no managerRoot or packageRoot (unmanaged invocation) never attempts delegation", async () => {
  await withDataHome(async () => {
    const root = await mkdtemp(path.join(tmpdir(), "acc-hook-unmanaged-"));
    const payload = { hook_event_name: "Notification", session_id: "session-unmanaged", cwd: root };
    process.exitCode = undefined;
    await withArgv(["claude_code", "Notification"], () => main({ payload }));
    assert.equal(process.exitCode, 0);
    process.exitCode = 0;
  });
});
