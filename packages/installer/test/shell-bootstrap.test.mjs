import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { uninstallShellBootstrap } from "../src/shell-bootstrap.mjs";
import { installShellBootstrap, planShellBootstrap }
  from "../../../tests/helpers/legacy-shell-bootstrap.mjs";

// ACC no longer writes a shell bootstrap; it only retires the ones 0.7.x
// wrote. The state under test is laid out by that version's own code.

const ENTRY = { adapterId: "claude_code", command: "claude",
  realExecutable: "/absolute/vendor/bin/claude",
  prefixArgs: ["--dangerously-load-development-channels", "plugin:agents-can-communicate@acc-local"],
  livePolicy: "actionable" };
const RUNTIME = { node: "/absolute/node", bootstrap: "/absolute/acc/bin/acc-bootstrap.mjs",
  dataHome: "/absolute/data" };

async function home(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-shell-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, rcFile: path.join(root, ".zshrc"), shimDir: path.join(root, "acc", "shims") };
}

const plan = (place, overrides = {}) => planShellBootstrap({ shell: "zsh", rcFile: place.rcFile,
  shimDir: place.shimDir, entries: [ENTRY], runtime: RUNTIME, ...overrides });

test("uninstall removes only matching bytes and the block only after the last shim", async t => {
  const place = await home(t);
  await writeFile(place.rcFile, "export FOO=1\n");
  const two = plan(place, { entries: [ENTRY, { ...ENTRY, adapterId: "codex", command: "codex",
    realExecutable: "/absolute/vendor/bin/codex", prefixArgs: ["--remote", "unix://"] }] });
  const owned = await installShellBootstrap({ plan: two });
  const only = { ...owned, shims: owned.shims.filter(shim => shim.command === "claude") };

  const partial = await uninstallShellBootstrap({ ownership: only });
  assert.deepEqual(partial.removedShims, [path.join(place.shimDir, "claude")]);
  assert.equal(partial.rcBlock, "kept", "the codex shim still needs the PATH block");
  assert.match(await readFile(place.rcFile, "utf8"), /native delivery/);

  const rest = { ...owned, shims: owned.shims.filter(shim => shim.command === "codex") };
  const full = await uninstallShellBootstrap({ ownership: rest });
  assert.equal(full.rcBlock, "removed");
  assert.equal(await readFile(place.rcFile, "utf8"), "export FOO=1\n");
  await assert.rejects(stat(place.shimDir), error => error.code === "ENOENT");
  const again = await uninstallShellBootstrap({ ownership: owned });
  assert.deepEqual(again.removedShims, []);
  assert.equal(again.rcBlock, "absent");
});

test("uninstall refuses a modified block and keeps a modified shim", async t => {
  const place = await home(t);
  await writeFile(place.rcFile, "");
  const owned = await installShellBootstrap({ plan: plan(place) });
  const shim = path.join(place.shimDir, "claude");
  await writeFile(shim, `${await readFile(shim, "utf8")}# mine now\n`);
  const rc = (await readFile(place.rcFile, "utf8")).replace("export PATH=", "export PATH=/x:");
  await writeFile(place.rcFile, rc);

  const result = await uninstallShellBootstrap({ ownership: owned });
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, "rc_block_modified");
  assert.deepEqual(result.keptShims, [shim]);
  assert.equal(await readFile(place.rcFile, "utf8"), rc);
  assert.match(await readFile(shim, "utf8"), /# mine now/);
});

// The rc file is the user's. Retiring ACC's block takes the block and leaves
// the file's permissions as they are, rather than tightening them to 0600.
test("retiring the block keeps the rc file's own permissions", async t => {
  const place = await home(t);
  await writeFile(place.rcFile, "export FOO=1\n");
  const owned = await installShellBootstrap({ plan: plan(place) });
  const { chmod } = await import("node:fs/promises");
  await chmod(place.rcFile, 0o644);

  const result = await uninstallShellBootstrap({ ownership: owned });

  assert.equal(result.rcBlock, "removed");
  assert.equal(await readFile(place.rcFile, "utf8"), "export FOO=1\n");
  assert.equal((await stat(place.rcFile)).mode & 0o777, 0o644);
});
