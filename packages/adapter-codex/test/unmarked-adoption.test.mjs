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
  assert.match(after, /^default_permissions = ":workspace"$/m);
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
  assert.match(after, /^default_permissions = ":workspace"$/m);
  assert.match(after, /^\[marketplaces\.other\]$/m);
  assert.match(after, /^\[hooks\.state\."agents-can-communicate@acc-local:hooks\.json:stop:0:0"\]$/m);
});
