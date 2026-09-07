import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createPackedAcc } from "../helpers/packed-acc.mjs";

const run = promisify(execFile);
const human = (packed, args) => run(process.execPath, [packed.accBin, ...args,
  "--home", packed.clientHome], { cwd: packed.project, env: packed.env });

test("a clean installed Codex integration tells the operator how to activate it", async t => {
  const packed = await createPackedAcc(t);
  await packed.setClientVersions({ codex: "0.153.4" });
  const preview = await human(packed, ["install", "--adapter", "codex", "--dry-run"]);
  assert.match(preview.stdout, /would install/);
  await assert.rejects(readFile(path.join(packed.clientHome, ".codex", "config.toml")),
    { code: "ENOENT" });

  const installed = await human(packed, ["install", "--adapter", "codex"]);
  assert.match(installed.stdout, /installed 1 adapter/);
  assert.match(installed.stdout, /codex.*\/hooks/i,
    "successful installation hid the client's hook review step");
  assert.match(installed.stdout, /trust/i);
  assert.match(installed.stdout, /restart|new session/i);

  const repeated = await packed.acc(["install", "--adapter", "codex", "--home", packed.clientHome]);
  assert.ok(repeated.operations[0].needsAction.some(line => /\/hooks/.test(line)),
    "machine-readable installation lost the adapter's activation action");
  const config = await readFile(path.join(packed.clientHome, ".codex", "config.toml"), "utf8");
  assert.doesNotMatch(config, /trusted_hash|dangerously.*trust/);
  const removed = await human(packed, ["uninstall", "--adapter", "codex"]);
  assert.doesNotMatch(removed.stdout, /\/hooks|review.*trust/i,
    "removal asked the operator to activate the removed integration");
});

test("an installed adapter exposes the preserved sandbox's required access check", async t => {
  const packed = await createPackedAcc(t);
  await packed.setClientVersions({ codex: "0.153.4" });
  const config = path.join(packed.clientHome, ".codex", "config.toml");
  await mkdir(path.dirname(config), { recursive: true });
  const original = '[sandbox_workspace_write]\nwritable_roots = ["/existing"]\n';
  await writeFile(config, original);

  const installed = await human(packed, ["install", "--adapter", "codex"]);
  assert.match(installed.stdout, /writable_roots/,
    "installation hid the existing sandbox's access check");
  assert.ok(installed.stdout.includes(path.join(packed.dataHome, "acc")));
  assert.ok((await readFile(config, "utf8")).startsWith(original));

  const doctor = await human(packed, ["doctor"]);
  assert.match(doctor.stdout, /writable_roots/,
    "doctor lost the access check after installation");
  await human(packed, ["uninstall", "--adapter", "codex"]);
  assert.equal(await readFile(config, "utf8"), original);
});
