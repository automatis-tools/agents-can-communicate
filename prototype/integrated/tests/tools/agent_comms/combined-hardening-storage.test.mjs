// Combined regressions 6-8 from docs/MIGRATION.md. The storage rules from 0003
// are exercised through the real CLI, so they are proven to survive on the code
// path that the 0002 protocol guard and the 0004 doctor also run through, not
// only through the direct library calls the archived unit tests use.
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { EXIT } from "../../../tools/agents/lib/errors.mjs";
import { createGitWorktreeFixture, pathExists, runCli } from "./helpers.mjs";

async function workspace(t) {
  const fixture = await createGitWorktreeFixture();
  t.after(fixture.cleanup);
  const run = (argv, options = {}) => runCli(fixture, [...argv, "--json"],
    { cwd: fixture.worktree, ...options });
  assert.equal((await run(["init"])).code, 0);
  for (const id of ["visual", "models"]) {
    const registered = await run(["register", "--id", id, "--role", "artist", "--task", "M2.7"]);
    assert.equal(registered.code, 0, registered.stderr);
  }
  return { fixture, run };
}

async function sendMessage({ run }, extra = []) {
  const sent = await run(["send", "--from", "visual", "--to", "models", "--type", "question",
    "--severity", "action", "--subject", "contract", "--body", "please confirm", ...extra]);
  assert.equal(sent.code, 0, sent.stderr);
  return JSON.parse(sent.stdout);
}

test("6: a symlinked registry parent is rejected on the command path", async t => {
  const { fixture, run } = await workspace(t);
  const registry = path.join(fixture.bus, "registry");
  const external = path.join(fixture.root, "external-registry");
  await rename(registry, external);
  await symlink(external, registry);
  const before = await readdir(external);

  const status = await run(["status"]);

  assert.equal(status.code, EXIT.DATA, status.stderr || status.stdout);
  assert.equal(status.stderr, "", "machine mode polluted stderr");
  assert.equal(JSON.parse(status.stdout).error.exit_code, EXIT.DATA);
  assert.deepEqual(await readdir(external), before,
    "a symlinked registry parent was read and rewritten");
});

test("6: a symlinked inbox parent is rejected on the command path", async t => {
  const context = await workspace(t);
  await sendMessage(context);
  const { fixture, run } = context;
  const inbox = path.join(fixture.bus, "inbox", "models");
  const external = path.join(fixture.root, "external-inbox");
  await rename(inbox, external);
  await symlink(external, inbox);
  const before = await readdir(external);

  const listed = await run(["inbox", "--id", "models"]);

  assert.equal(listed.code, EXIT.DATA, listed.stderr || listed.stdout);
  assert.deepEqual(await readdir(external), before,
    "a symlinked inbox parent was read and marked seen");
});

test("7: an inbox filename that does not match its record id is data corruption", async t => {
  const context = await workspace(t);
  const message = await sendMessage(context);
  const { fixture, run } = context;
  const canonical = path.join(fixture.bus, "inbox", "models", `${message.id}.json`);
  const alias = path.join(fixture.bus, "inbox", "models", `${message.id}-alias.json`);
  await rename(canonical, alias);

  const listed = await run(["inbox", "--id", "models"]);

  assert.equal(listed.code, EXIT.DATA, listed.stderr || listed.stdout);
  assert.equal(JSON.parse(listed.stdout).error.exit_code, EXIT.DATA);
});

test("7: an archive filename cannot claim another recipient directory", async t => {
  const context = await workspace(t);
  const message = await sendMessage(context, ["--requires-ack"]);
  const { fixture, run } = context;
  const misplaced = path.join(fixture.bus, "archive", "visual", `${message.id}.json`);
  await mkdir(path.dirname(misplaced), { recursive: true });
  await rename(path.join(fixture.bus, "inbox", "models", `${message.id}.json`), misplaced);

  const acked = await run(["ack", "--id", "visual", "--message", message.id]);

  assert.equal(acked.code, EXIT.DATA, acked.stderr || acked.stdout);
  assert.deepEqual(JSON.parse(await readFile(misplaced, "utf8")).to, "models",
    "a misfiled archive record was rewritten to match its directory");
});

test("8: acknowledgement never overwrites conflicting archive evidence", async t => {
  const context = await workspace(t);
  const message = await sendMessage(context, ["--requires-ack"]);
  const { fixture, run } = context;
  assert.equal((await run(["inbox", "--id", "models"])).code, 0);
  const archived = path.join(fixture.bus, "archive", "models", `${message.id}.json`);
  await mkdir(path.dirname(archived), { recursive: true });
  const conflicting = `${JSON.stringify({ ...message, subject: "someone else's evidence" })}\n`;
  await writeFile(archived, conflicting);

  const acked = await run(["ack", "--id", "models", "--message", message.id]);

  assert.equal(acked.code, EXIT.DATA, acked.stderr || acked.stdout);
  assert.equal(await readFile(archived, "utf8"), conflicting,
    "acknowledgement replaced immutable archive evidence");

  // The receipt is written before the archive move on purpose: it is the
  // evidence doctor requires to finish an interrupted move. So the incomplete
  // state must be durable AND visible, and repair must still refuse to
  // overwrite the conflicting archive.
  assert.equal(await pathExists(path.join(fixture.bus, "acknowledgements",
    `${message.id}--models.json`)), true, "the acknowledgement receipt was lost");
  const diagnosed = await run(["doctor"]);
  assert.equal(JSON.parse(diagnosed.stdout).issues
    .some(item => item.code === "ACKED_MESSAGE_NOT_ARCHIVED"), true,
  "an unfinished archive move was not reported");

  const repaired = await run(["doctor", "--repair"]);

  assert.notEqual(repaired.code, 0, "repair claimed success over conflicting archive evidence");
  assert.equal(await readFile(archived, "utf8"), conflicting,
    "repair replaced immutable archive evidence");
});

test("8: acknowledging an already published identical archive stays idempotent", async t => {
  const context = await workspace(t);
  const message = await sendMessage(context, ["--requires-ack"]);
  const { fixture, run } = context;
  assert.equal((await run(["inbox", "--id", "models"])).code, 0);
  const first = await run(["ack", "--id", "models", "--message", message.id]);
  assert.equal(first.code, 0, first.stderr);
  const archived = path.join(fixture.bus, "archive", "models", `${message.id}.json`);
  const bytes = await readFile(archived);

  const second = await run(["ack", "--id", "models", "--message", message.id]);

  assert.notEqual(second.code, EXIT.DATA,
    "a republished identical archive was reported as corruption");
  assert.deepEqual(await readFile(archived), bytes, "a repeated ack rewrote the archive");
});
