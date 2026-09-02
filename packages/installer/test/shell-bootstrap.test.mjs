import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { BLOCK_BEGIN, BLOCK_END, installShellBootstrap, locateBlock, planShellBootstrap,
  renderCommandShim, renderPathBlock, shellLiteral, uninstallShellBootstrap }
  from "../src/shell-bootstrap.mjs";

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

test("the shim is made of escaped literals and keeps the user's command", () => {
  const shim = renderCommandShim({ ...RUNTIME, entry: { ...ENTRY,
    realExecutable: "/odd path/it's here/claude", prefixArgs: ["--x", "$(rm -rf /)", "a b"] } });
  assert.match(shim, /^#!\/bin\/sh\n/);
  assert.equal(shim.includes("'/odd path/it'\\''s here/claude'"), true);
  assert.equal(shim.includes("'$(rm -rf /)'"), true);
  assert.equal(shim.includes("eval"), false);
  assert.match(shim, /if \[ "\$\{ACC_BYPASS-\}" = "1" \]; then\n  unset ACC_NATIVE_DELIVERY_POLICY\n  exec '\/odd path\/it'\\''s here\/claude' "\$@"\nfi/);
  assert.match(shim, /ACC_NATIVE_DELIVERY_POLICY='actionable'\n  export ACC_NATIVE_DELIVERY_POLICY\n  exec '[^\n]*' '--x' '\$\(rm -rf \/\)' 'a b' "\$@"/);
  assert.match(shim, /\nunset ACC_NATIVE_DELIVERY_POLICY\nexec '[^\n]*' "\$@"\n$/);
  assert.equal(shellLiteral("it's"), "'it'\\''s'");
});

test("entries and plans are closed, and a shim never resolves itself", () => {
  const bad = patch => () => renderCommandShim({ ...RUNTIME, entry: { ...ENTRY, ...patch } });
  assert.throws(bad({ command: "claude && rm" }), /bare command name/);
  assert.throws(bad({ realExecutable: "vendor/claude" }), /absolute/);
  assert.throws(bad({ prefixArgs: ["--flag\ninjected"] }), /prefixArgs/);
  assert.throws(bad({ livePolicy: "off" }), /livePolicy/);
  assert.throws(bad({ transcript: "x" }), /unknown shim entry field transcript/);
  assert.throws(() => renderCommandShim({ ...RUNTIME, node: "node", entry: ENTRY }), /node/);
  assert.throws(() => planShellBootstrap({ shell: "zsh", rcFile: "/rc", shimDir: "/shims",
    entries: [{ ...ENTRY, realExecutable: "/shims/claude" }] }), /inside the shim directory/);
  assert.throws(() => planShellBootstrap({ shell: "zsh", rcFile: "/rc", shimDir: "/shims",
    entries: [ENTRY, ENTRY] }), /duplicate/);
  for (const shell of ["bash", "fish", undefined, "ZSH"]) {
    const refused = planShellBootstrap({ shell, rcFile: "/rc", shimDir: "/shims", entries: [ENTRY] });
    assert.equal(refused.eligible, false);
    assert.equal(refused.reasonCode, "unsupported_shell");
    assert.deepEqual(refused.shims, []);
  }
});

test("the zsh block carries exact sentinels and an escaped shim directory", () => {
  const block = renderPathBlock("/home/it's/shims");
  assert.equal(block, `${BLOCK_BEGIN}\nexport PATH='/home/it'\\''s/shims':"$PATH"\n${BLOCK_END}\n`);
  assert.deepEqual(locateBlock(`before\n${block}after\n`), { start: 7, end: 7 + block.length });
  assert.equal(locateBlock("no block here"), null);
  assert.equal(locateBlock(`x${BLOCK_BEGIN}\n${BLOCK_END}\n`), null);
});

test("install appends once, preserves every user byte, and is idempotent", async t => {
  const place = await home(t);
  const userBytes = "# my rc\r\nexport FOO='bar'\nalias ll='ls -la'";
  await writeFile(place.rcFile, userBytes);
  const first = await installShellBootstrap({ plan: plan(place) });
  assert.equal(first.ok, true);
  assert.equal(first.rcFile.appended, true);
  const afterFirst = await readFile(place.rcFile, "utf8");
  assert.equal(afterFirst, `${userBytes}\n${renderPathBlock(place.shimDir)}`);
  assert.equal((await stat(place.shimDir)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(place.shimDir, "claude"))).mode & 0o777, 0o700);
  assert.match(await readFile(path.join(place.shimDir, "claude"), "utf8"),
    /agents-can-communicate native delivery shim/);

  const second = await installShellBootstrap({ plan: plan(place) });
  assert.equal(second.ok, true);
  assert.equal(second.rcFile.appended, false);
  assert.equal(await readFile(place.rcFile, "utf8"), afterFirst);
  assert.deepEqual(second.shims, first.shims);
  assert.equal(JSON.stringify(first).includes("#!/bin/sh"), false);
});

test("install writes nothing when the block was changed by someone else", async t => {
  const place = await home(t);
  await writeFile(place.rcFile, `${BLOCK_BEGIN}\nexport PATH="/somewhere/else:$PATH"\n${BLOCK_END}\n`);
  const result = await installShellBootstrap({ plan: plan(place) });
  assert.deepEqual(result, { ok: false, reasonCode: "rc_block_modified", rcFile: place.rcFile });
  await assert.rejects(readdir(place.shimDir), error => error.code === "ENOENT");
});

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
