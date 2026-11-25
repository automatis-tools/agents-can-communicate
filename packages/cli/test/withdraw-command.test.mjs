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

// `acc withdraw` (#145) as two agents use it, in separate processes against one
// data home: the question leaves the recipient's inbox, the reason arrives in
// its place, and a second withdrawal of the same question is refused.

async function workspace(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-withdraw-")));
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-withdraw-home-")));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }),
    rm(dataHome, { recursive: true, force: true })]));
  const env = { ...process.env, ACC_DATA_HOME: dataHome, HOME: dataHome, ACC_NO_UPDATE_CHECK: "1" };
  const run = async argv => {
    try {
      const { stdout } = await execFileAsync(process.execPath, [binary, ...argv, "--json"],
        { cwd: root, env });
      return { code: 0, body: JSON.parse(stdout) };
    } catch (error) {
      return { code: error.code, stderr: error.stderr, body: JSON.parse(error.stdout || "null") };
    }
  };
  const attach = async participant => (await run(["attach", "--participant", participant,
    "--harness", "cli"])).body.data;
  const as = session => ["--session", session.sessionId, "--generation", session.generation];
  return { run, attach, as };
}

test("a withdrawn question leaves the recipient's inbox and the reason arrives instead", async t => {
  const place = await workspace(t);
  const asker = await place.attach("asker");
  const alice = await place.attach("alice");
  const asked = await place.run(["message", "--to", "alice", "--type", "question",
    "--subject", "Port choice", "--body", "Which port?", ...place.as(asker)]);
  const questionId = asked.body.data.message.messageId;
  const subjects = async () => (await place.run(["inbox", ...place.as(alice)]))
    .body.data.items.map(item => item.message.subject);
  assert.deepEqual(await subjects(), ["Port choice"]);

  const withdrawn = await place.run(["withdraw", "--message", questionId,
    "--reason", "Settled in review.", ...place.as(asker)]);

  assert.equal(withdrawn.code, 0, withdrawn.stderr);
  assert.deepEqual(withdrawn.body.data.withdrawn.map(receipt => receipt.recipientParticipantId),
    ["alice"]);
  assert.deepEqual(await subjects(), ["Withdrawn: Port choice"]);

  const again = await place.run(["withdraw", "--message", questionId,
    "--reason", "Once more.", ...place.as(asker)]);
  assert.equal(again.code, 5, JSON.stringify(again.body));
  assert.match(JSON.stringify(again.body), /every recipient already answered or acknowledged/);
});

test("only the sender may withdraw, and the recipient cannot withdraw for it", async t => {
  const place = await workspace(t);
  const asker = await place.attach("asker");
  const alice = await place.attach("alice");
  const asked = await place.run(["request", "--to", "alice", "--title", "Review the parser",
    ...place.as(asker)]);

  const refused = await place.run(["withdraw", "--message", asked.body.data.message.messageId,
    "--reason", "I would rather not.", ...place.as(alice)]);

  assert.equal(refused.code, 5, JSON.stringify(refused.body));
  assert.match(JSON.stringify(refused.body), /only the participant that sent a message can withdraw it/);
});
