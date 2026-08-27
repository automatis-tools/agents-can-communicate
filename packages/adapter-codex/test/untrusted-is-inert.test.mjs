import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createCodexAdapter } from "../src/adapter.mjs";

/**
 * Installed, enabled, and running nothing.
 *
 * This client will not run a hook it has no trust record for, and it does not
 * say so. It prints `hook: SessionStart Completed` and executes nothing - proven
 * by replacing ACC's hook with a two-line script that only appends its stdin to
 * a file, and getting an empty file alongside a `Completed` line.
 *
 * Every other indicator says the opposite. On the machine where this was found:
 *
 *   acc doctor         → 4 of 4 adapter(s) installed
 *   codex plugin list  → installed, enabled, 0.1.10
 *   the write guard    → off
 *
 * Silently losing the write guard is the worst failure this tool has, so the one
 * condition that decides whether ACC runs here at all is worth reading before
 * reporting the client healthy.
 */
async function home(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "acc-inert-"));
  const state = await mkdtemp(path.join(tmpdir(), "acc-inert-state-"));
  t.after(() => Promise.all([dir, state]
    .map(one => rm(one, { recursive: true, force: true }))));
  return { home: dir, stateRoot: state };
}

const TRUSTED = `
[hooks.state."agents-can-communicate@acc-local:hooks.json:pre_tool_use:0:0"]
trusted_hash = "sha256:8d4a13568a8748e93b91e512b415eaf97817fbc138997bd91017bec936e6be14"
`;

const diagnosticsOf = async context =>
  (await createCodexAdapter().doctor(context)).diagnostics;

const actionsOf = async context =>
  (await createCodexAdapter().detect(context)).needsAction ?? [];

test("an installed plugin with no trust record is reported as inert", async t => {
  const context = await home(t);
  await createCodexAdapter().install(context);

  const said = await diagnosticsOf(context);

  assert.equal(said.some(line => /not trusted|inert/i.test(line)), true,
    `nothing said the hooks will not run: ${JSON.stringify(said, null, 2)}`);
  // The state is described here; what to do about it is an action, and the test
  // below checks it separately - because only a person can carry it out.
});

test("once the client has trusted them, the warning goes away", async t => {
  const context = await home(t);
  await createCodexAdapter().install(context);
  const file = path.join(context.home, ".codex", "config.toml");
  await writeFile(file, (await readFile(file, "utf8")) + TRUSTED);

  const said = await diagnosticsOf(context);

  assert.equal(said.some(line => /not trusted|inert/i.test(line)), false,
    `a healthy install was told its hooks will not run: ${JSON.stringify(said, null, 2)}`);
});

test("the thing a person must do is said where a person reads it", async t => {
  // The first version of this fix put it in `diagnostics`, which `acc doctor`
  // renders only under --json. On the machine it was written for, the text
  // output stayed silent and the guard stayed off.
  const context = await home(t);
  await createCodexAdapter().install(context);

  const actions = await actionsOf(context);

  assert.equal(actions.length, 1, `no action was asked for: ${JSON.stringify(actions)}`);
  assert.match(actions[0], /codex/);
  assert.match(actions[0], /trust/i);
});

test("a client with no ACC installed at all is not nagged about trust", async t => {
  // Nothing is wired, so there is nothing to trust. "Your hooks are untrusted"
  // about hooks that do not exist is noise, and noise is how a real diagnosis
  // gets ignored.
  const context = await home(t);

  const said = await diagnosticsOf(context);

  assert.equal(said.some(line => /not trusted|inert/i.test(line)), false,
    `an empty machine was warned about trust: ${JSON.stringify(said, null, 2)}`);
});
