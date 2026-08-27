import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { wiredVersion } from "../src/doctor-command.mjs";

/**
 * Which ACC a client will actually run.
 *
 * `staleInstall` compared the version recorded at install time against the one
 * running now, which works until the thing that rewrote the wiring is an ACC old
 * enough not to know the field. Observed: an 0.1.1 sitting under a different
 * Node version was first on PATH for one `acc install`. It rewired all four
 * clients to itself **and** rewrote `installs.json` with `accVersion: null`,
 * erasing the only evidence that anything had changed. Both the record-based
 * check and a version guard in the planner went quiet, and the sole symptom was
 * a guard behaving like the version it came from.
 *
 * The record can be overwritten by whoever writes last. The shim cannot lie in
 * the same way: it carries the absolute path of the runner the client will
 * execute, and an old ACC writes it honestly, pointing at itself.
 */
async function shim(t, runnerPackageVersion, { withPackage = true } = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-wired-")));
  t.after(() => rm(root, { recursive: true, force: true }));

  const pkg = path.join(root, "lib", "node_modules", "agents-can-communicate");
  await mkdir(path.join(pkg, "bin"), { recursive: true });
  if (withPackage) {
    await writeFile(path.join(pkg, "package.json"),
      JSON.stringify({ name: "agents-can-communicate", version: runnerPackageVersion }));
  }
  const runner = path.join(pkg, "bin", "acc-hook.mjs");
  await writeFile(runner, "// runner\n");

  const file = path.join(root, "acc-hook.sh");
  await writeFile(file, "#!/bin/sh\n"
    + `exec "${path.join(root, "bin", "node")}" "${runner}" claude_code "$@"\n`);
  return { file, runner };
}

test("the version a client will run is read out of its own shim", async t => {
  const { file } = await shim(t, "0.1.1");

  assert.equal(await wiredVersion(file), "0.1.1");
});

test("a shim pointing at a runner with no manifest answers null, not a guess", async t => {
  const { file } = await shim(t, "0.1.1", { withPackage: false });

  assert.equal(await wiredVersion(file), null);
});

test("a file that is not a shim is not read as one", async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-wired-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "settings.json");
  await writeFile(file, '{"theme":"dark"}\n');

  assert.equal(await wiredVersion(file), null);
});

test("a path that is not there answers null rather than throwing", async () => {
  assert.equal(await wiredVersion("/nowhere/acc-hook.sh"), null);
  assert.equal(await wiredVersion(undefined), null);
});

test("this is what the record could not tell you", async t => {
  // The point of reading the shim: it still answers after an old ACC has blanked
  // the record. `staleInstall(null, running)` says nothing; the shim says 0.1.1.
  const { staleInstall } = await import("../src/doctor-command.mjs");
  const { file } = await shim(t, "0.1.1");

  assert.equal(staleInstall({ recorded: null, running: "0.1.8" }), null);
  assert.equal(await wiredVersion(file), "0.1.1");
});
