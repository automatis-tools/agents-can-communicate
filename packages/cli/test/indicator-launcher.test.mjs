import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { writeLaunchers } from "../src/managed-runtime/launchers.mjs";
import { writeControl } from "../src/managed-runtime/state.mjs";

const exec = promisify(execFile);
test("a saved indicator launcher follows an update without leases or a surviving old generation", async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-indicator-launcher-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const generations = path.join(root, "generations");
  for (const version of ["1.0.0", "1.0.1"]) {
    const bin = path.join(generations, version, "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, "acc-indicator.mjs"), `process.stdout.write('${version}');\n`);
  }
  const control = { schemaVersion: 1, phase: "ready", auto: false, pin: null,
    checkedAt: null, notice: null, home: root, targets: ["claude_code"], pending: null,
    active: { version: "1.0.0", root: path.join(generations, "1.0.0"), storeVersion: 7 } };
  await writeControl(root, control);
  const paths = await writeLaunchers(root, control.active.root);
  assert.equal(typeof paths.indicatorRunner, "string", "plugins need a stable observation entrypoint");
  const run = () => exec(process.execPath, ["--permission", "--allow-fs-read=*", paths.indicatorRunner]);
  assert.equal((await run()).stdout, "1.0.0");
  await writeControl(root, { ...control,
    active: { version: "1.0.1", root: path.join(generations, "1.0.1"), storeVersion: 7 } });
  await rm(control.active.root, { recursive: true });
  const before = await readFile(path.join(root, "control.json"));
  assert.equal((await run()).stdout, "1.0.1");
  assert.deepEqual(await readFile(path.join(root, "control.json")), before);
  assert.equal((await readdir(root)).includes("leases"), false);
});
