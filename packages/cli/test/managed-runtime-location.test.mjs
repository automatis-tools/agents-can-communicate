import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { installManaged } from "../src/managed-runtime/install.mjs";

// Invalid source is intentional: unsafe locations must fail before any staging access.
test("managed install checks declared and plain workspace boundaries before touching source", async t => {
  const base = await mkdtemp(path.join(tmpdir(), "acc-location-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const cwd = path.join(base, "project"), other = path.join(base, "declared");
  await mkdir(cwd); await mkdir(other);
  const install = managerRoot => installManaged({ packageRoot: path.join(base, "missing-source"),
    managerRoot, home: path.join(base, "home"), cwd, env: {} });
  await assert.rejects(install(path.join(cwd, "data", "acc", "runtime")), /outside.*workspace/);
  await writeFile(path.join(cwd, "acc.workspace.json"), JSON.stringify({ roots: ["../declared"] }));
  await assert.rejects(install(path.join(other, "data", "acc", "runtime")), /outside.*workspace/);
});

// HOME/root launch locations are not implicit project declarations.
test("managed install permits external data from HOME and root but honors explicit workspace markers", async t => {
  const base = await mkdtemp(path.join(tmpdir(), "acc-location-home-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const source = path.join(base, "missing-source");
  const options = { packageRoot: source, managerRoot: path.join(base, "data", "acc", "runtime"),
    home: base, cwd: base, env: { HOME: base } };
  // Reaching missing source proves the read-only location guard admitted it.
  await assert.rejects(installManaged(options), { code: "ENOENT" });
  await assert.rejects(installManaged({ ...options, cwd: path.parse(base).root }), { code: "ENOENT" });
  await assert.rejects(installManaged({ ...options, env: { HOME: base, ACC_WORKSPACE_ROOT: base } }), /outside.*workspace/);
  await writeFile(path.join(base, "acc.workspace.json"), "malformed");
  await assert.rejects(installManaged(options), /outside.*workspace/);
});

// The launcher resolves the manager with Node built-ins only, so it carries its
// own copy of the data-home rule; it has to agree with platformDataHome.
test("on Windows the launcher finds the manager under local, not roaming, app data", async () => {
  const { managerLocation } = await import("../src/managed-runtime/entry.mjs");
  assert.equal(managerLocation({ platform: "win32", env: {
    APPDATA: "C:\\Users\\dana\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\dana\\AppData\\Local" } }),
  "C:\\Users\\dana\\AppData\\Local\\acc\\runtime");
  assert.throws(() => managerLocation({ platform: "win32",
    env: { APPDATA: "C:\\Users\\dana\\AppData\\Roaming" } }), /cannot resolve ACC data home/);
});
