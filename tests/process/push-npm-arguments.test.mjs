// Real shim selection and exact data argv catch the old package lookup and shell mutation.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runPushCommand } from "../../scripts/push-targets.mjs";
import { windowsNpmFixture } from "../helpers/windows-npm-fixture.mjs";

const cwd = process.cwd();
test("Windows npm selects external forwarding shim and preserves shell-free argv", async t => {
  const f = await windowsNpmFixture(t);
  const sentinel = path.join(f.root, "shell-side-effect");
  const args = ["test", "--", "--selection-plan",
    'C:\\Users\\Jane Doe\\plan & (owned) %PATH% !literal! ^data\\selection.json', ` & echo injected > "${sentinel}" &`, "--if-needed"];
  await runPushCommand("npm", args, { cwd: f.cwd, quiet: true, platform: "win32", env: f.env, spawnCommand: f.launch });
  const records = await f.records();
  assert.equal(records.length, 2, "fixed version query and validation run exactly once each");
  assert.deepEqual(records[0].args, ["--version", "--offline", "--update-notifier=false", "--logs-max=0", "--color=false"]);
  assert.deepEqual(records[1].args, args);
  for (const record of records) { assert.equal(record.label, "first"); assert.equal(record.node, f.node); assert.equal(record.cwd, f.cwd); }
  assert.equal(records[1].env.NODE_OPTIONS, f.env.NODE_OPTIONS);
  assert.equal(records[1].env.ACC_NPM_MARKER, "original");
  assert.equal(records[1].env.ACC_ORIGINAL_PRELOAD, "ran");
  assert.equal(records[1].env.ACC_PUSH_NPM_PROBE, undefined);
  assert.equal(existsSync(sentinel), false, "argv must not execute a shell side effect");
  assert.equal(f.calls.at(-1).file, f.node);
  assert.deepEqual(f.calls.at(-1).args, [f.clis[0], ...args]);
});

test("already cancelled npm commands never launch a child", async () => {
  const controller = new AbortController(); controller.abort();
  let launched = false;
  await assert.rejects(runPushCommand("npm", ["test"], { cwd, platform: "win32", signal: controller.signal,
    spawnCommand: () => { launched = true; throw Error("unexpected spawn"); } }), /push validation interrupted/);
  assert.equal(launched, false);
});

test("ordinary spawn errors retain the command error", async () => {
  const denied = Object.assign(Error("spawn denied"), { code: "EACCES" });
  await assert.rejects(runPushCommand("npm", ["test"], { cwd, platform: "darwin",
    spawnCommand: () => { throw denied; } }), error => error === denied);
});
