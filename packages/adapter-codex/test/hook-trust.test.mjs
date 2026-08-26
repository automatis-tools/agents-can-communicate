import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { removeHookTrust } from "../src/install.mjs";

/**
 * The record this client keeps about ACC's hooks.
 *
 * Codex stores one `[hooks.state."plugin@marketplace:file:event:i:j"]` table per
 * hook, holding the hash it trusted. ACC writes none of them - a search of the
 * shipped package finds no occurrence of `hooks.state` - so after `acc
 * uninstall` five tables were left naming a plugin that no longer exists, and
 * five more arrived on the next install.
 *
 * Checked before writing this: a hook whose recorded hash no longer matches
 * still runs. Both a control run and a run against a modified file returned
 * normally. So this is tidiness, and it must not reach past ACC's own keys.
 */
const PREFIX = "agents-can-communicate@acc-local:";

async function config(t, text) {
  const home = await mkdtemp(path.join(tmpdir(), "acc-hook-trust-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, "config.toml");
  await writeFile(file, text, "utf8");
  return file;
}

const ACC_TABLES = `[hooks.state."agents-can-communicate@acc-local:hooks.json:pre_tool_use:0:0"]
trusted_hash = "sha256:8d4a13"

[hooks.state."agents-can-communicate@acc-local:hooks.json:session_start:0:0"]
trusted_hash = "sha256:a17bdb"
`;

test("the trust record for ACC's own hooks is taken back out", async t => {
  const file = await config(t, ACC_TABLES);

  assert.equal(await removeHookTrust(file, PREFIX), true);

  const after = await readFile(file, "utf8");
  assert.equal(after.includes("agents-can-communicate"), false);
  assert.equal(after.trim(), "");
});

test("another plugin's trust record is not ACC's to remove", async t => {
  const theirs = `[hooks.state."simplify@local-marketplace:hooks.json:stop:0:0"]
trusted_hash = "sha256:deadbeef"
`;
  const file = await config(t, `${ACC_TABLES}\n${theirs}`);

  assert.equal(await removeHookTrust(file, PREFIX), true);

  const after = await readFile(file, "utf8");
  assert.equal(after.includes("agents-can-communicate"), false);
  assert.match(after, /simplify@local-marketplace/);
  assert.match(after, /sha256:deadbeef/);
});

test("the user's own configuration around it is untouched", async t => {
  const mine = `model = "gpt-5"

[sandbox_workspace_write]
writable_roots = ["/tmp"]

`;
  const file = await config(t, `${mine}${ACC_TABLES}`);

  await removeHookTrust(file, PREFIX);

  const after = await readFile(file, "utf8");
  assert.match(after, /model = "gpt-5"/);
  assert.match(after, /\[sandbox_workspace_write\]/);
  assert.match(after, /writable_roots = \["\/tmp"\]/);
});

test("a config with nothing of ACC's in it is not rewritten at all", async t => {
  const theirs = `model = "gpt-5"

[hooks.state."simplify@local-marketplace:hooks.json:stop:0:0"]
trusted_hash = "sha256:deadbeef"
`;
  const file = await config(t, theirs);

  assert.equal(await removeHookTrust(file, PREFIX), false);
  assert.equal(await readFile(file, "utf8"), theirs);
});

test("a config that is not there is not an error", async t => {
  const file = await config(t, "");
  await rm(file);

  assert.equal(await removeHookTrust(file, PREFIX), false);
});
