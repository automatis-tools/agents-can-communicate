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

// `acc inbox --wait` (#147) as an agent runs it: a separate process that blocks
// while a peer sends, then prints the page. The skill's review wait relies on
// exactly this, in place of an inbox read and a foreground `sleep 5`.

async function workspace(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-wait-")));
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-wait-home-")));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }),
    rm(dataHome, { recursive: true, force: true })]));
  const env = { ...process.env, ACC_DATA_HOME: dataHome, HOME: dataHome, ACC_NO_UPDATE_CHECK: "1" };
  const run = async (argv, json = true) => {
    try {
      const { stdout } = await execFileAsync(process.execPath,
        [binary, ...argv, ...(json ? ["--json"] : [])], { cwd: root, env });
      return { code: 0, stdout, body: json ? JSON.parse(stdout) : null };
    } catch (error) {
      return { code: error.code, stdout: error.stdout, stderr: error.stderr,
        body: json ? JSON.parse(error.stdout || "null") : null };
    }
  };
  const attach = async participant => (await run(["attach", "--participant", participant,
    "--harness", "cli"])).body.data;
  const as = session => ["--session", session.sessionId, "--generation", session.generation];
  return { run, attach, as };
}

test("the wait returns as soon as a peer sends, with the message on the page", async t => {
  const place = await workspace(t);
  const reviewer = await place.attach("reviewer");
  const author = await place.attach("author");
  const started = Date.now();
  const waiting = place.run(["inbox", "--wait", "60", ...place.as(author)]);
  await new Promise(resolve => setTimeout(resolve, 1_500));
  const sent = await place.run(["message", "--to", "author", "--type", "question",
    "--subject", "verdict", "--body", "Approved.", ...place.as(reviewer)]);
  assert.equal(sent.code, 0, JSON.stringify(sent.body));

  const result = await waiting;

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.body.data.wait.arrived, true);
  assert.deepEqual(result.body.data.items.map(item => item.message.subject), ["verdict"]);
  assert.equal(result.body.data.items[0].receipt.state, "queued", "the wait retrieves nothing");
  assert.ok(Date.now() - started < 30_000, "it returned on arrival, well before its minute");
});

test("a wait that times out says so, and exits 0", async t => {
  const place = await workspace(t);
  const author = await place.attach("author");

  const result = await place.run(["inbox", "--wait", "1", ...place.as(author)], false);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /"arrived": false/);
  assert.match(result.stdout, /no new message after 1s\n?$/);
});

test("--wait refuses values and combinations it cannot honour", async t => {
  const place = await workspace(t);
  const author = await place.attach("author");
  for (const extra of [["--wait", "0"], ["--wait", "601"], ["--wait", "1.5"], ["--wait", "soon"],
    ["--wait", "5", "--message", "message_x"], ["--wait", "5", "--cursor", "message_x"]]) {
    const result = await place.run(["inbox", ...extra, ...place.as(author)]);
    assert.equal(result.code, 2, `${extra.join(" ")}: ${result.stdout}`);
  }
});
