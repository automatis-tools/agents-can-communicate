import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createCodexAdapter } from "../src/adapter.mjs";

// #329: another program rewrote the maintainer's config.toml, sorted its tables
// and dropped every comment, ACC's ownership markers included. ACC then took its
// own entries for foreign ones, and the update failed for every client.
async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), "acc-codex-unmarked-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const codexHome = path.join(home, ".codex");
  await mkdir(codexHome);
  const file = path.join(codexHome, "config.toml");
  const context = { home, codexHome, dataHome: path.join(home, "data"),
    stateRoot: path.join(home, "data", "acc"), node: process.execPath,
    runner: fileURLToPath(new URL("../../../bin/acc-hook.mjs", import.meta.url)),
    cli: fileURLToPath(new URL("../../../bin/acc.mjs", import.meta.url)),
    clientVersion: "0.164.0", platform: "darwin-arm64", requestedLivePolicy: "actionable",
    livePolicy: "off", env: {} };
  return { context, file, read: () => readFile(file, "utf8"), write: text => writeFile(file, text),
    adapter: createCodexAdapter() };
}

// ACC writes no rules file on Windows, so there it keeps selecting its own profile.
const DEFAULT = process.platform === "win32" ? /^default_permissions = "acc-workspace"$/m
  : /^default_permissions = ":workspace"$/m;
const stripComments = text => text.split("\n").filter(line => !line.trim().startsWith("#")).join("\n");
const count = (text, pattern) => (text.match(pattern) ?? []).length;
const foreign = '[marketplaces.other]\nsource = "https://example.invalid/skills.git"\nsource_type = "git"\n\n'
  + '[plugins."helper@other"]\nenabled = true\n\n'
  + '[hooks.state."agents-can-communicate@acc-local:hooks.json:stop:0:0"]\ntrusted_hash = "sha256:abc"\n';

async function rewrittenInstall(f, version = "0.153.4") {
  await f.write(`model = "user-model"\n\n${foreign}`);
  await f.adapter.install({ ...f.context, clientVersion: version });
  const rewritten = stripComments(await f.read());
  await f.write(rewritten);
  return rewritten;
}

test("an install whose markers a rewrite removed is adopted and marked again", async t => {
  const f = await fixture(t);
  const rewritten = await rewrittenInstall(f);
  assert.match(rewritten, /^default_permissions = "acc-workspace"$/m);

  await f.adapter.install(f.context);
  const after = await f.read();

  assert.match(after, /^# >>> agents-can-communicate/m);
  assert.match(after, /^# ACC native permissions begin profile$/m);
  assert.equal(count(after, /^\[marketplaces\.acc-local\]$/gm), 1);
  assert.equal(count(after, /^\[permissions\.acc-workspace\]$/gm), 1);
  assert.equal(count(after, /^default_permissions = /gm), 1);
  assert.match(after, DEFAULT);
  assert.ok(after.includes(foreign), "the client's own tables changed");
  const detected = await f.adapter.detect(f.context);
  assert.equal(detected.outgoingDelivery.state, "configured");
});

test("uninstall of an unmarked install removes ACC's entries and keeps the client's", async t => {
  const f = await fixture(t);
  await rewrittenInstall(f);

  await f.adapter.uninstall(f.context);
  const after = await f.read();

  assert.equal(count(after, /acc-local\]/g), 0);
  assert.equal(count(after, /^\[permissions\.acc-workspace/gm), 0);
  assert.equal(count(after, /acc-workspace/g), 0);
  assert.ok(after.includes(foreign), "the client's own tables changed");
  assert.match(after, /^model = "user-model"$/m);
});

test("unmarked entries that differ from what ACC writes are still refused", async t => {
  for (const change of [
    text => text.replace(/^source = ".*acc-local"$/m, 'source = "/somewhere/else"'),
    text => text.replace(/(\[plugins\."agents-can-communicate@acc-local"\]\n)enabled = true/, "$1enabled = false"),
  ]) {
    const f = await fixture(t);
    const changed = change(await rewrittenInstall(f));
    await f.write(changed);

    await assert.rejects(f.adapter.install(f.context), /already registered/);
    assert.equal(await f.read(), changed);
  }
});

test("an unmarked profile with a key ACC never writes stays the user's policy", async t => {
  const f = await fixture(t);
  const changed = (await rewrittenInstall(f)).replace(/^\[permissions\.acc-workspace\.network\]\n/m,
    '[permissions.acc-workspace.network]\nmode = "limited"\n');
  await f.write(changed);

  const result = await f.adapter.install(f.context);
  const after = await f.read();

  assert.match(after, /^# >>> agents-can-communicate/m);
  assert.match(after, /^mode = "limited"$/m);
  assert.match(after, /^default_permissions = "acc-workspace"$/m);
  assert.ok(result.diagnostics.some(line => /custom permission policy was preserved/.test(line)),
    result.diagnostics.join("\n"));
});

// The rewrite on the maintainer's machine also sorted the file: top-level keys
// first, then every table in key order.
const sortTables = text => {
  const [top, ...chunks] = text.split(/\n(?=\[)/);
  const keys = top.split("\n").filter(line => line.trim() !== "").sort();
  return [keys.join("\n"), ...chunks.map(chunk => chunk.trim()).sort()].join("\n\n") + "\n";
};

test("the sorted, comment-free shape of the maintainer's config is adopted", async t => {
  const f = await fixture(t);
  const sorted = sortTables(await rewrittenInstall(f));
  await f.write(sorted);
  assert.match(sorted, /^default_permissions = "acc-workspace"\nmodel = /m);

  await f.adapter.install(f.context);
  const after = await f.read();

  assert.equal(count(after, /^\[marketplaces\.acc-local\]$/gm), 1);
  assert.equal(count(after, /^\[permissions\.acc-workspace\]$/gm), 1);
  assert.equal(count(after, /^default_permissions = /gm), 1);
  assert.match(after, DEFAULT);
  assert.match(after, /^\[marketplaces\.other\]$/m);
  assert.match(after, /^\[hooks\.state\."agents-can-communicate@acc-local:hooks\.json:stop:0:0"\]$/m);
});

test("an adopted install that selected Codex's workspace mode uninstalls to a config that selects nothing", async t => {
  const f = await fixture(t);
  const rewritten = await rewrittenInstall(f, "0.164.0");
  assert.match(rewritten, /^default_permissions = /m);

  await f.adapter.install(f.context);
  assert.equal(count(await f.read(), /^default_permissions = /gm), 1);
  await f.adapter.uninstall(f.context);
  const after = await f.read();

  assert.equal(count(after, /^default_permissions = /gm), 0, after);
  assert.match(after, /^model = "user-model"$/m);
});

test("an unmarked profile that grants a socket ACC never grants stays the user's policy", async t => {
  const f = await fixture(t);
  const changed = (await rewrittenInstall(f)).replace(/^(\[permissions\.acc-workspace\.network\.unix_sockets\]\n)/m,
    '$1"/private/tmp/someone-else.sock" = "allow"\n');
  await f.write(changed);

  const result = await f.adapter.install(f.context);
  const after = await f.read();

  assert.match(after, /^"\/private\/tmp\/someone-else\.sock" = "allow"$/m);
  assert.equal(count(after, /^\[permissions\.acc-workspace\]$/gm), 1);
  assert.ok(result.diagnostics.some(line => /custom permission policy was preserved/.test(line)),
    result.diagnostics.join("\n"));
});

test("comments a user added among ACC's unmarked tables stay", async t => {
  const f = await fixture(t);
  const changed = (await rewrittenInstall(f))
    .replace(/^(\[marketplaces\.acc-local\]\n)/m, "$1# inside the marketplace\n")
    .replace(/^(\[plugins\."agents-can-communicate@acc-local"\]\nenabled = true\n)/m, "$1# after the plugin\n")
    .replace(/^(\[permissions\.acc-workspace\]\n)/m, "$1# inside the profile\n");
  await f.write(changed);

  await f.adapter.install(f.context);
  const installed = await f.read();
  await f.adapter.uninstall(f.context);
  const removed = await f.read();

  for (const text of [installed, removed]) {
    for (const comment of ["# inside the marketplace", "# after the plugin", "# inside the profile"]) {
      assert.ok(text.includes(`${comment}\n`), `${comment} was removed:\n${text}`);
    }
  }
});

test("a registration with a part ACC never writes is left whole", async t => {
  for (const change of [
    text => text.replace(/^(\[plugins\."agents-can-communicate@acc-local"\])/m,
      '[marketplaces.acc-local.extra]\nnote = "mine"\n\n$1'),
    text => text.replace(/^source = ".*acc-local"$/m, 'source = "/somewhere/else"'),
    text => text.replace(/^source_type = "local"\n(source = .*\n)/m, "$1$1"),
  ]) {
    const f = await fixture(t);
    const changed = change(await rewrittenInstall(f));
    await f.write(changed);

    await assert.rejects(f.adapter.install(f.context), /already registered/);
    await f.adapter.uninstall(f.context);
    const after = await f.read();

    assert.equal(count(after, /^\[marketplaces\.acc-local\]$/gm), 1, after);
    assert.equal(count(after, /^\[plugins\."agents-can-communicate@acc-local"\]$/gm), 1, after);
  }
});

test("ACC's unmarked entries written as TOML literal strings are adopted", async t => {
  const f = await fixture(t);
  const changed = (await rewrittenInstall(f)).replace(/^(\S+) = "([^"\\]*)"$/gm, "$1 = '$2'")
    .replace(/^"([^"\\]*)" = /gm, "'$1' = ");
  assert.match(changed, /^source = '/m);
  await f.write(changed);

  await f.adapter.install(f.context);
  const after = await f.read();

  assert.equal(count(after, /^\[marketplaces\.acc-local\]$/gm), 1);
  assert.equal(count(after, /^\[permissions\.acc-workspace\]$/gm), 1);
  assert.match(after, /^# ACC native permissions begin profile$/m);
});

test("an unmarked profile that another setting still names is kept", async t => {
  const f = await fixture(t);
  const changed = `${await rewrittenInstall(f)}\n[profiles.review]\ndefault_permissions = "acc-workspace"\n`;
  await f.write(changed);

  await f.adapter.install(f.context);
  const after = await f.read();

  assert.equal(count(after, /^\[permissions\.acc-workspace\]$/gm), 1);
  assert.match(after, /^\[profiles\.review\]\ndefault_permissions = "acc-workspace"$/m);
});

test("an empty permissions table a rewrite left above ACC's profile goes with it", async t => {
  const f = await fixture(t);
  const changed = (await rewrittenInstall(f)).replace(/^(\[permissions\.acc-workspace\]\n)/m, "[permissions]\n\n$1");
  await f.write(changed);

  await f.adapter.install(f.context);
  const installed = await f.read();
  assert.doesNotMatch(installed, /^\[permissions\]$/m);
  assert.equal((await f.adapter.detect(f.context)).outgoingDelivery.state, "configured");

  await f.adapter.uninstall(f.context);
  assert.doesNotMatch(await f.read(), /^\[permissions/m);
});
