import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createCodexAdapter } from "../src/adapter.mjs";

// A saved hash is not current readiness: the real client listed partial,
// commented and stale trust as untrusted/modified, and allows trusted hooks
// to be disabled. ACC must direct verification to the client in each case.
async function home(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "acc-inert-"));
  const state = await mkdtemp(path.join(tmpdir(), "acc-inert-state-"));
  t.after(() => Promise.all([dir, state]
    .map(one => rm(one, { recursive: true, force: true }))));
  return { home: dir, stateRoot: state };
}

const RECORDED = `
[hooks.state."agents-can-communicate@acc-local:hooks.json:pre_tool_use:0:0"]
trusted_hash = "sha256:8d4a13568a8748e93b91e512b415eaf97817fbc138997bd91017bec936e6be14"
`;

const diagnosticsOf = async context =>
  (await createCodexAdapter().doctor(context)).diagnostics;

const actionsOf = async context =>
  (await createCodexAdapter().detect(context)).needsAction ?? [];

test("an installed cache reports hook readiness as unverified", async t => {
  const context = await home(t);
  await createCodexAdapter().install(context);

  const said = await diagnosticsOf(context);

  assert.match(said.join("\n"), /hook.*unverified|hook.*not verified/i);
  assert.doesNotMatch(said.join("\n"), /runs nothing|hooks are not trusted/i);
});

test("saved, disabled or commented hook records cannot verify current readiness", async t => {
  const context = await home(t);
  await createCodexAdapter().install(context);
  const file = path.join(context.home, ".codex", "config.toml");
  const original = await readFile(file, "utf8");
  for (const record of [RECORDED, RECORDED + "enabled = false\n",
    '\n# [hooks.state."agents-can-communicate@acc-local:hooks.json:pre_tool_use:0:0"]\n']) {
    await writeFile(file, original + record);
    assert.match((await diagnosticsOf(context)).join("\n"), /hook.*unverified|hook.*not verified/i);
    assert.ok((await actionsOf(context)).some(line => /\/hooks/.test(line)),
      "a saved trust substring suppressed current hook review");
    assert.equal(await readFile(file, "utf8"), original + record,
      "detection changed the client's trust decision");
  }
});

test("the thing a person must do is said where a person reads it", async t => {
  // The first version of this fix put it in `diagnostics`, which `acc doctor`
  // renders only under --json. On the machine it was written for, the text
  // output stayed silent and the guard stayed off.
  const context = await home(t);
  await createCodexAdapter().install(context);

  const actions = await actionsOf(context);

  const hookAction = actions.find(line => /\/hooks/.test(line));
  assert.ok(hookAction, `no hook review was asked for: ${JSON.stringify(actions)}`);
  assert.match(hookAction, /codex/);
  assert.match(hookAction, /trust/i);
});

test("a plugin registration cannot establish that the client enabled it", async t => {
  const context = await home(t);
  await createCodexAdapter().install(context);
  const file = path.join(context.home, ".codex", "config.toml");
  await writeFile(file, (await readFile(file, "utf8")).replace("enabled = true", "enabled = false"));
  assert.doesNotMatch((await diagnosticsOf(context)).join("\n"), /plugin enabled|no hook would run/i);
  assert.ok((await actionsOf(context)).some(line => /\/plugins/.test(line)));
});

test("a client with no ACC installed at all is not nagged about trust", async t => {
  // Nothing is wired, so there is nothing to trust. "Your hooks are untrusted"
  // about hooks that do not exist is noise, and noise is how a real diagnosis
  // gets ignored.
  const context = await home(t);

  const said = await diagnosticsOf(context);

  assert.equal(said.some(line => /hook.*unverified|hook.*not verified/i.test(line)), false,
    `an empty machine was warned about trust: ${JSON.stringify(said, null, 2)}`);
  assert.deepEqual(await actionsOf(context), []);
});
