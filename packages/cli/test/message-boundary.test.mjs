import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { EXIT } from "@agents-can-communicate/protocol";

const runFile = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const binary = path.join(repoRoot, "bin", "acc.mjs");

async function workspace(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-cli-message-")));
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-cli-message-home-")));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }),
    rm(dataHome, { recursive: true, force: true })]));
  const json = async argv => {
    try {
      const { stdout, stderr } = await runFile(process.execPath,
        [binary, ...argv, "--json"], { cwd: root,
          env: { ...process.env, ACC_DATA_HOME: dataHome, HOME: dataHome } });
      return { code: 0, stderr, body: JSON.parse(stdout) };
    } catch (error) {
      return { code: error.code, stderr: error.stderr ?? "", body: JSON.parse(error.stdout) };
    }
  };
  const attach = async participant => (await json(
    ["attach", "--participant", participant, "--harness", "cli"])).body.data;
  return { json, attach };
}

test("generic message refuses reply-only and handoff-only kinds before core", async t => {
  const { json, attach } = await workspace(t);
  const sender = await attach("sender");
  await attach("recipient");
  const base = ["message", "--session", sender.sessionId, "--generation", sender.generation,
    "--to", "recipient", "--subject", "Wrong surface", "--body", "Not constructible"];

  for (const kind of ["answer", "handoff"]) {
    const result = await json([...base, "--type", kind]);
    assert.equal(result.code, EXIT.USAGE, `${kind} reached the core: ${result.stderr}`);
    assert.match(result.body.error.message, kind === "answer" ? /reply/ : /finish/);
  }
  const status = await json(["status"]);
  assert.equal(status.body.data.counts.messages, 0);
});

test("reply and finish retries keep one message for one explicit client key", async t => {
  const { json, attach } = await workspace(t);
  const sender = await attach("sender");
  const recipient = await attach("recipient");
  const sent = await json(["message", "--session", sender.sessionId, "--generation",
    sender.generation, "--to", "recipient", "--subject", "Gate", "--body", "Proceed?",
    "--type", "question"]);
  const messageId = sent.body.data.message.messageId;
  const replyArgs = ["reply", "--session", recipient.sessionId, "--generation",
    recipient.generation, "--message", messageId, "--body", "Proceed.",
    "--client-message-id", "client_cli_reply_retry"];

  const firstReply = await json(replyArgs);
  const retryReply = await json(replyArgs);
  assert.equal(retryReply.body.data.message.messageId,
    firstReply.body.data.message.messageId);

  const finishArgs = ["finish", "--session", recipient.sessionId, "--generation",
    recipient.generation, "--goal", "Hand off", "--client-message-id",
    "client_cli_finish_retry"];
  const firstFinish = await json(finishArgs);
  const retryFinish = await json(finishArgs);
  assert.equal(retryFinish.code, 0, retryFinish.stderr);
  assert.equal(retryFinish.body.data.message.messageId,
    firstFinish.body.data.message.messageId);

  const status = await json(["status"]);
  assert.equal(status.body.data.counts.messages, 3);
});
