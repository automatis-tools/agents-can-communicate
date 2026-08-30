import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { recordInstall } from "@agents-can-communicate/installer";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const binary = path.join(repoRoot, "bin", "acc.mjs");

/**
 * Doctor, run against a machine whose wiring came from a different ACC.
 *
 * The unit test beside this one covers reading a version out of a shim. This one
 * covers the path the doctor actually walks to find that shim - a recorded tree
 * artifact - which is the half that was missing when the helper shipped without
 * its `readdir` import: every test passed, and the real `acc doctor` died with
 * `readdir is not defined` on the first machine that had a tree recorded.
 */
async function machine(t, wiredVersion, accVersion = null) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "acc-wired-home-")));
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-wired-data-")));
  t.after(() => Promise.all([home, dataHome]
    .map(dir => rm(dir, { recursive: true, force: true }))));

  // A package that is not this one, with its own version, exactly as a second
  // global install under another Node version would be.
  const other = path.join(home, "other-node", "lib", "node_modules", "agents-can-communicate");
  await mkdir(path.join(other, "bin"), { recursive: true });
  await writeFile(path.join(other, "package.json"),
    JSON.stringify({ name: "agents-can-communicate", version: wiredVersion }));
  await writeFile(path.join(other, "bin", "acc-hook.mjs"), "// runner\n");

  // The tree ACC records for this client, with the shim nested inside it the way
  // a real plugin cache nests one.
  const tree = path.join(home, ".claude", "plugins", "cache", "acc-local",
    "agents-can-communicate", "0.1.6");
  await mkdir(path.join(tree, "hooks"), { recursive: true });
  await writeFile(path.join(tree, "hooks", "acc-hook.sh"),
    `#!/bin/sh\nexec "/usr/bin/node" "${path.join(other, "bin", "acc-hook.mjs")}" claude_code "$@"\n`);

  await recordInstall({ dataHome, adapterId: "claude_code", version: "2.1.0",
    accVersion, artifacts: [{ path: tree, kind: "tree" }] });
  return { home, dataHome };
}

const doctor = async ({ home, dataHome }) => {
  const { stdout } = await execFileAsync(process.execPath, [binary, "doctor", "--json"],
    { cwd: home, env: { ...process.env, HOME: home, ACC_DATA_HOME: dataHome } })
    .catch(error => ({ stdout: error.stdout ?? "null" }));
  return JSON.parse(stdout);
};

test("doctor names the ACC each client will actually run", async t => {
  const place = await machine(t, "0.1.1");

  const body = await doctor(place);

  assert.equal(body.ok, true, JSON.stringify(body).slice(0, 300));
  const entry = body.data.adapters.find(one => one.adapterId === "claude_code");
  assert.equal(entry.wired, "0.1.1");
  assert.equal(entry.remediation.some(line => /wired to acc 0\.1\.1/.test(line)), true,
    `no remediation naming the wired version: ${JSON.stringify(entry.remediation)}`);
});

test("the record being blank does not stop the diagnosis", async t => {
  // This is the whole point. An ACC old enough not to know `accVersion` rewrites
  // the record with null while pointing every client at itself, so the
  // record-based check goes quiet exactly when something has gone wrong.
  const place = await machine(t, "0.1.1");

  const body = await doctor(place);
  const entry = body.data.adapters.find(one => one.adapterId === "claude_code");

  assert.equal(entry.stale, null, "the record had nothing to say, as expected");
  assert.equal(entry.wired, "0.1.1", "the wiring still answered");
});

test("wiring that matches the running acc says nothing", async t => {
  const running = JSON.parse(
    await (await import("node:fs/promises")).readFile(
      path.join(repoRoot, "package.json"), "utf8")).version;
  const place = await machine(t, running);

  const body = await doctor(place);
  const entry = body.data.adapters.find(one => one.adapterId === "claude_code");

  assert.equal(entry.wired, running);
  assert.equal(entry.remediation.some(line => /wired to acc/.test(line)), false,
    "a healthy machine was told to reinstall");
});

test("a stale bundle names the skills, not the runtime, and reports its version", async t => {
  // The real npm-upgrade case: `npm i -g` refreshed the CLI and the hook
  // runtime, so the runner the client points at is already the running version,
  // but the skills and manifests copied into the client are from the acc that
  // last ran `acc install`. Doctor used to call that "plugin is <old>", which
  // reads as a stale runtime and sits beside a `wired` that says otherwise.
  const running = JSON.parse(
    await (await import("node:fs/promises")).readFile(
      path.join(repoRoot, "package.json"), "utf8")).version;
  const place = await machine(t, running, "0.0.1");

  const body = await doctor(place);
  const entry = body.data.adapters.find(one => one.adapterId === "claude_code");

  // The runtime is current; the bundle is not - and the record now says both.
  assert.equal(entry.wired, running, "the runner the client executes is current");
  assert.equal(entry.bundleVersion, "0.0.1",
    "the recorded install version is surfaced as the bundle's version");

  const line = entry.remediation.find(one => /skills|manifests|bundle/.test(one));
  assert.notEqual(line, undefined,
    `no remediation names the stale bundle: ${JSON.stringify(entry.remediation)}`);
  assert.match(line, /acc install --adapter claude_code/,
    "the bundle line is not the reinstall command");
  assert.match(line, /0\.0\.1/, "the bundle line does not name the stale version");
  assert.equal(entry.remediation.some(one => /\bplugin is\b/.test(one)), false,
    "a remediation still calls the whole plugin stale when only the bundle is");
})
