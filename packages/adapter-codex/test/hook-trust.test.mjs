import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createCodexAdapter } from "../src/adapter.mjs";

/**
 * The trust record this client keeps about ACC's hooks.
 *
 * Codex stores one `[hooks.state."plugin@marketplace:file:event:i:j"]` table per
 * hook, holding a hash it has trusted. It will not run a hook it has no record
 * for - and it says nothing about that. It prints `hook: SessionStart Completed`
 * and executes nothing.
 *
 * 0.1.9 removed these tables on uninstall, calling them litter that named a
 * plugin no longer there. The reasoning was checked the wrong way: a hook whose
 * recorded hash no longer *matched* was observed still running, and that was
 * taken to mean the record was inert. Absence was never tested. Absence is what
 * matters.
 *
 * Measured afterwards, on a real machine: with the tables gone, ACC's write
 * guard was silently off in Codex while `acc doctor` reported `4 of 4
 * adapter(s) installed` and `codex plugin list` reported the plugin enabled. A
 * shell write walked through a guarded claim. Writing the exact same hashes back
 * - captured before the deletion, from an ACC three versions older - revived the
 * guard immediately, which is also how we know the record survives ACC upgrades
 * and is granted once, interactively, for good.
 *
 * So it is never ACC's to delete: it is the client's permission for ACC to run
 * at all, and nothing ACC can write puts it back.
 */
const TRUST = `[hooks.state."agents-can-communicate@acc-local:hooks.json:pre_tool_use:0:0"]
trusted_hash = "sha256:8d4a13568a8748e93b91e512b415eaf97817fbc138997bd91017bec936e6be14"

[hooks.state."agents-can-communicate@acc-local:hooks.json:session_start:0:0"]
trusted_hash = "sha256:a17bdb450ab476b3f0f03fbf8c0f61ec5d2714fe419b12c9599e8a62dc763571"
`;

async function home(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "acc-hook-trust-"));
  const state = await mkdtemp(path.join(tmpdir(), "acc-hook-trust-state-"));
  t.after(() => Promise.all([dir, state]
    .map(one => rm(one, { recursive: true, force: true }))));
  return { home: dir, stateRoot: state };
}

const config = context => path.join(context.home, ".codex", "config.toml");

test("uninstall leaves the client's trust in ACC's hooks alone", async t => {
  const context = await home(t);
  const adapter = createCodexAdapter();
  await adapter.install(context);

  // As the client writes it once a person has accepted the hooks.
  await writeFile(config(context), `${await readFile(config(context), "utf8")}\n${TRUST}`);

  await adapter.uninstall(context);

  const after = await readFile(config(context), "utf8");
  assert.match(after, /pre_tool_use/,
    "the guard's trust was removed; nothing ACC can write puts it back");
  assert.match(after, /session_start/);
  assert.match(after, /8d4a13568a8748e93b91e512b415eaf97817fbc138997bd91017bec936e6be14/,
    "the hash was rewritten rather than left as the client wrote it");
});

test("a reinstall over surviving trust is what makes the guard work again", async t => {
  // The whole point of leaving it: install, uninstall, install again, and the
  // hooks still run - no interactive step, because the record never left.
  const context = await home(t);
  const adapter = createCodexAdapter();
  await adapter.install(context);
  await writeFile(config(context), `${await readFile(config(context), "utf8")}\n${TRUST}`);

  await adapter.uninstall(context);
  await adapter.install(context);

  const after = await readFile(config(context), "utf8");
  assert.match(after, /hooks\.state\."agents-can-communicate@acc-local:/);
  assert.match(after, /\[plugins\."agents-can-communicate@acc-local"\]/,
    "the plugin registration did not come back");
});

test("uninstall still removes everything that is ACC's own", async t => {
  // Leaving the trust record must not turn into leaving the wiring: what ACC
  // wrote still goes.
  const context = await home(t);
  const adapter = createCodexAdapter();
  await adapter.install(context);
  await writeFile(config(context), `${await readFile(config(context), "utf8")}\n${TRUST}`);

  await adapter.uninstall(context);

  const after = await readFile(config(context), "utf8");
  assert.equal(after.includes('[plugins."agents-can-communicate@acc-local"]'), false,
    "ACC's own plugin registration survived the uninstall");
  assert.equal(after.includes("sandbox_workspace_write"), false,
    "ACC's own sandbox table survived the uninstall");
});
