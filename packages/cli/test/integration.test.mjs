import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { EXIT } from "@agents-can-communicate/protocol";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const binary = path.join(repoRoot, "bin", "acc.mjs");

async function workspace(t) {
  // A plain directory with no Git: the non-Git path is a first-class case, not
  // a degraded one.
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-cli-")));
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-home-")));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }),
    rm(dataHome, { recursive: true, force: true })]));

  const run = async (argv, options = {}) => {
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [binary, ...argv],
        { cwd: options.cwd ?? root, env: { ...process.env, ACC_DATA_HOME: dataHome,
          HOME: dataHome, ...options.env } });
      return { code: 0, stdout, stderr };
    } catch (error) {
      return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
    }
  };
  const json = async argv => {
    const result = await run([...argv, "--json"]);
    return { ...result, body: result.stdout.trim() === "" ? null : JSON.parse(result.stdout) };
  };
  return { root, dataHome, run, json };
}

const attach = async (json, participant) => {
  const attached = await json(["attach", "--participant", participant, "--harness", "cli"]);
  assert.equal(attached.code, 0, attached.stderr);
  return attached.body.data;
};

test("a session attaches, works, claims, and finishes through the executable", async t => {
  const { json } = await workspace(t);

  const first = await attach(json, "visual");
  const second = await attach(json, "models");

  const work = await json(["work", "--session", first.sessionId, "--generation",
    first.generation, "--summary", "porting claims", "--mode", "edit"]);
  assert.equal(work.code, 0, work.stderr);

  const claimed = await json(["claim", "--session", first.sessionId, "--generation",
    first.generation, "--resource", "file:packages/core/src/claims.mjs",
    "--reason", "editing"]);
  assert.equal(claimed.code, 0, claimed.stderr);

  const blocked = await json(["claim", "--session", second.sessionId, "--generation",
    second.generation, "--resource", "file:packages/core/src/claims.mjs",
    "--reason", "also editing"]);
  assert.equal(blocked.code, EXIT.CONFLICT);
  assert.equal(blocked.body.ok, false);
  assert.equal(blocked.body.error.details.ownerSessionId, first.sessionId);

  const finished = await json(["finish", "--session", first.sessionId, "--generation",
    first.generation, "--goal", "hand over the claim model", "--status", "partial"]);
  assert.equal(finished.code, 0, finished.stderr);
  assert.deepEqual(finished.body.data.claimsToRelease,
    ["file:packages/core/src/claims.mjs"]);

  const after = await json(["status"]);
  assert.deepEqual(after.body.data.claims, [], "finish did not release the owned claim");
});

test("machine mode writes exactly one JSON object and nothing to stderr", async t => {
  const { json } = await workspace(t);
  const attached = await json(["attach", "--participant", "visual"]);

  assert.equal(attached.stderr, "");
  assert.equal(attached.stdout.trimEnd().split("\n").length, 1);
  assert.equal(attached.body.ok, true);
  assert.equal(typeof attached.body.envelope_version, "number");
});

test("a failure in machine mode is a JSON envelope, not a stack on stderr", async t => {
  const { json } = await workspace(t);

  const failed = await json(["detach", "--session", "session_missing",
    "--generation", "generation_missing"]);

  assert.equal(failed.code, EXIT.CONFLICT);
  assert.equal(failed.stderr, "");
  assert.equal(failed.body.ok, false);
  assert.equal(failed.body.error.code, EXIT.CONFLICT);
  assert.equal(JSON.stringify(failed.body).includes(".mjs:"), false);
});

test("human mode reports errors on stderr and keeps stdout clean", async t => {
  const { run } = await workspace(t);

  const failed = await run(["detach", "--session", "session_missing",
    "--generation", "generation_missing"]);

  assert.equal(failed.code, EXIT.CONFLICT);
  assert.equal(failed.stdout, "");
  assert.notEqual(failed.stderr, "");
});

test("usage errors are reported before any workspace is touched", async t => {
  const { json, dataHome } = await workspace(t);

  const unknown = await json(["teleport"]);
  const missing = await json(["attach"]);

  assert.equal(unknown.code, EXIT.USAGE);
  assert.equal(missing.code, EXIT.USAGE);
  assert.equal(missing.body.error.message.includes("--participant"), true);
  // Nothing was created: a usage error must not materialise a runtime tree.
  assert.deepEqual(await readdir(dataHome), []);
});

test("a lone session leaves no durable state and syncs to silence", async t => {
  const { run, json, dataHome } = await workspace(t);
  const session = await attach(json, "visual");

  const synced = await run(["sync", "--session", session.sessionId]);

  // Solo zero-overhead: no peers, no attention, so no output at all.
  assert.equal(synced.code, 0, synced.stderr);
  assert.equal(synced.stdout, "");
  const state = path.join(dataHome, "acc", "workspaces");
  const workspaces = await readdir(state);
  const stateDir = path.join(state, workspaces[0], "state");
  assert.deepEqual(await readdir(stateDir), [], "a lone session materialised durable state");
});

test("doctor reports a healthy store and status counts live sessions", async t => {
  const { json } = await workspace(t);
  await attach(json, "visual");
  await attach(json, "models");

  const doctor = await json(["doctor"]);
  const status = await json(["status"]);

  assert.equal(doctor.code, 0, doctor.stderr);
  assert.equal(doctor.body.data.store.healthy, true);
  assert.equal(doctor.body.data.materialised, true);
  assert.equal(status.body.data.counts.live, 2);
  assert.equal(status.body.data.protection, "none");
});

test("two directories are two workspaces, and runtime state stays outside both", async t => {
  const { json, root, dataHome } = await workspace(t);
  const other = await realpath(await mkdtemp(path.join(tmpdir(), "acc-other-")));
  t.after(() => rm(other, { recursive: true, force: true }));

  await attach(json, "visual");
  const elsewhere = await execFileAsync(process.execPath,
    [binary, "attach", "--participant", "visual", "--harness", "cli", "--json"],
    { cwd: other, env: { ...process.env, ACC_DATA_HOME: dataHome, HOME: dataHome } });

  assert.equal(JSON.parse(elsewhere.stdout).ok, true);
  assert.equal((await readdir(path.join(dataHome, "acc", "workspaces"))).length, 2);
  assert.deepEqual(await readdir(root), [], "runtime state leaked into the workspace");
  assert.deepEqual(await readdir(other), []);
});

test("a message reaches a peer and status counts it", async t => {
  const { json } = await workspace(t);
  const first = await attach(json, "visual");
  await attach(json, "models");

  const sent = await json(["message", "--session", first.sessionId, "--generation",
    first.generation, "--to", "models", "--subject", "Material slots",
    "--body", "Which names are stable?", "--type", "question", "--requires-ack"]);

  assert.equal(sent.code, 0, sent.stderr);
  assert.equal(sent.body.data.requiresAck, true);
  const status = await json(["status", "--participant", "models"]);
  assert.equal(status.body.data.counts.messages, 1);
  assert.equal(status.body.data.attention.some(item => item.kind === "direct_request"), true);
});

test("inbox reads one message and reply answers plus acknowledges it", async t => {
  const { json } = await workspace(t);
  const sender = await attach(json, "visual");
  const recipient = await attach(json, "models");
  const sent = await json(["message", "--session", sender.sessionId, "--generation",
    sender.generation, "--to", "models", "--subject", "Material gate",
    "--body", "Can visual proceed?", "--type", "question", "--requires-ack"]);
  const messageId = sent.body.data.messageId;

  const inbox = await json(["inbox", "--session", recipient.sessionId, "--generation",
    recipient.generation, "--message", messageId]);
  assert.equal(inbox.code, 0, inbox.stderr);
  assert.deepEqual(inbox.body.data.map(item => item.message.messageId), [messageId]);
  assert.equal(inbox.body.data[0].receipt.state, "seen");
  assert.equal(Object.hasOwn(inbox.body.data[0], "snapshot"), false);

  const replied = await json(["reply", "--session", recipient.sessionId, "--generation",
    recipient.generation, "--message", messageId, "--body", "Yes, proceed."]);
  assert.equal(replied.code, 0, replied.stderr);
  assert.equal(replied.body.data.reply.inReplyTo, messageId);
  assert.equal(replied.body.data.receipt.state, "acknowledged");
});
