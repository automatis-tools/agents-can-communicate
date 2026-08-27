import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const binary = path.join(repoRoot, "bin", "acc.mjs");

/**
 * A claim that names who holds it, in the vocabulary you address them by.
 *
 * `acc status --json` gave a claim's owner as a session id, and every command
 * that reaches a peer - `acc message --to`, `acc request --to` - takes a
 * participant id. So "who is holding this file, and how do I ask them for it"
 * needed a join through the roster that every caller had to write for itself.
 * Observed costing a live agent that step during an end-to-end run; the guard's
 * own deny message and the injected context had named the participant all
 * along.
 */
async function workspace(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-owner-")));
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-owner-home-")));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }),
    rm(dataHome, { recursive: true, force: true })]));

  const json = async argv => {
    try {
      const { stdout } = await execFileAsync(process.execPath, [binary, ...argv, "--json"],
        { cwd: root, env: { ...process.env, ACC_DATA_HOME: dataHome, HOME: dataHome } });
      return { code: 0, body: JSON.parse(stdout) };
    } catch (error) {
      return { code: error.code, body: JSON.parse(error.stdout ?? "null") };
    }
  };
  const attach = async participant => {
    const attached = await json(["attach", "--participant", participant, "--harness", "cli"]);
    assert.equal(attached.code, 0, JSON.stringify(attached.body));
    return attached.body.data;
  };
  return { json, attach };
}

test("a claim names its owner as a participant, not only as a session", async t => {
  const place = await workspace(t);
  const alice = await place.attach("alice");
  await place.json(["claim", "--session", alice.sessionId, "--generation", alice.generation,
    "--resource", "file:src/parser.mjs", "--reason", "rewriting"]);

  const status = await place.json(["status"]);
  const [claim] = status.body.data.claims;

  assert.equal(claim.ownerSessionId, alice.sessionId, "the session id is still carried");
  assert.equal(claim.ownerParticipantId, "alice",
    "a claim must name the owner in the vocabulary `--to` takes");
});

test("the owner it names is the one a message can actually be sent to", async t => {
  // The join done for you is only worth anything if the result is addressable.
  const place = await workspace(t);
  const alice = await place.attach("alice");
  const bob = await place.attach("bob");
  await place.json(["claim", "--session", alice.sessionId, "--generation", alice.generation,
    "--resource", "file:src/parser.mjs", "--reason", "rewriting"]);

  const status = await place.json(["status"]);
  const owner = status.body.data.claims[0].ownerParticipantId;

  const sent = await place.json(["message", "--session", bob.sessionId,
    "--generation", bob.generation, "--to", owner,
    "--subject", "may I have it", "--body", "asking for the parser"]);

  assert.equal(sent.code, 0, JSON.stringify(sent.body));
});

test("a claim whose owning session has left still names the participant", async t => {
  // The roster keeps closed sessions, which is what makes this answerable at
  // all. Reporting null here would send the reader back to the join.
  const place = await workspace(t);
  const alice = await place.attach("alice");
  await place.json(["claim", "--session", alice.sessionId, "--generation", alice.generation,
    "--resource", "file:src/parser.mjs", "--reason", "rewriting"]);
  await place.json(["detach", "--session", alice.sessionId, "--generation", alice.generation]);

  const status = await place.json(["status"]);
  const [claim] = status.body.data.claims;

  assert.equal(claim?.ownerParticipantId, "alice");
});
