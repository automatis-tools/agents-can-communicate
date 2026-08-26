import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { EXIT } from "@agents-can-communicate/protocol";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const binary = path.join(repoRoot, "bin", "acc.mjs");

/**
 * Giving a claim back the way it was taken.
 *
 * `acc claim --resource file:src/parser.mjs` and then `acc release --claim
 * claim_LM69YGb8…`: the id is not something the caller ever chose, so releasing
 * meant a round trip through `acc status --json` first. Observed costing a real
 * agent a step mid-task. Both spellings work now, and the id stays the precise
 * one where a resource is ambiguous.
 */
async function workspace(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-release-")));
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-release-home-")));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }),
    rm(dataHome, { recursive: true, force: true })]));

  const json = async argv => {
    const argument = [...argv, "--json"];
    try {
      const { stdout } = await execFileAsync(process.execPath, [binary, ...argument],
        { cwd: root, env: { ...process.env, ACC_DATA_HOME: dataHome, HOME: dataHome } });
      return { code: 0, body: JSON.parse(stdout) };
    } catch (error) {
      return { code: error.code,
        body: error.stdout?.trim() === "" ? null : JSON.parse(error.stdout ?? "null") };
    }
  };

  const attach = async participant => {
    const attached = await json(["attach", "--participant", participant, "--harness", "cli"]);
    assert.equal(attached.code, 0, JSON.stringify(attached.body));
    return attached.body.data;
  };
  return { json, attach };
}

test("a claim is given back by the resource it was taken on", async t => {
  const place = await workspace(t);
  const session = await place.attach("alice");

  const claimed = await place.json(["claim", "--session", session.sessionId,
    "--generation", session.generation,
    "--resource", "file:src/parser.mjs", "--reason", "rewriting"]);
  assert.equal(claimed.code, 0, JSON.stringify(claimed.body));

  const released = await place.json(["release", "--session", session.sessionId,
    "--generation", session.generation,
    "--resource", "file:src/parser.mjs"]);

  assert.equal(released.code, 0, JSON.stringify(released.body));
  // The id still comes back, because that is what was released.
  assert.equal(released.body.data.claimId, claimed.body.data.claimId);

  const status = await place.json(["status"]);
  assert.deepEqual(status.body.data.claims, []);
});

test("the id still works, and still names what it released", async t => {
  const place = await workspace(t);
  const session = await place.attach("alice");
  const claimed = await place.json(["claim", "--session", session.sessionId,
    "--generation", session.generation,
    "--resource", "file:src/parser.mjs", "--reason", "rewriting"]);

  const released = await place.json(["release", "--session", session.sessionId,
    "--generation", session.generation,
    "--claim", claimed.body.data.claimId]);

  assert.equal(released.code, 0, JSON.stringify(released.body));
  assert.equal(released.body.data.claimId, claimed.body.data.claimId);
});

test("naming neither says what the two spellings are", async t => {
  const place = await workspace(t);
  const session = await place.attach("alice");

  const refused = await place.json(["release", "--session", session.sessionId,
    "--generation", session.generation]);

  assert.equal(refused.code, EXIT.USAGE);
  assert.match(refused.body.error.message, /--resource/);
  assert.match(refused.body.error.message, /--claim/);
});

test("releasing a resource nobody claimed says so, and lists what is held", async t => {
  const place = await workspace(t);
  const session = await place.attach("alice");
  await place.json(["claim", "--session", session.sessionId,
    "--generation", session.generation,
    "--resource", "file:src/render.mjs", "--reason", "rendering"]);

  const refused = await place.json(["release", "--session", session.sessionId,
    "--generation", session.generation,
    "--resource", "file:src/parser.mjs"]);

  assert.equal(refused.code, EXIT.DATA);
  assert.match(refused.body.error.message, /no claim on file:src\/parser\.mjs/);
  assert.deepEqual(refused.body.error.details.held, ["file:src/render.mjs"]);
});

test("a peer's claim is not released by naming its resource", async t => {
  // Without the owner check this would hand one session the power to release
  // another's claim by spelling, which is what `--authority` exists to do
  // deliberately and loudly.
  const place = await workspace(t);
  const owner = await place.attach("alice");
  const other = await place.attach("bob");
  await place.json(["claim", "--session", owner.sessionId,
    "--generation", owner.generation,
    "--resource", "file:src/parser.mjs", "--reason", "rewriting"]);

  const refused = await place.json(["release", "--session", other.sessionId,
    "--generation", other.generation,
    "--resource", "file:src/parser.mjs"]);

  assert.equal(refused.code, EXIT.DATA);
  assert.match(refused.body.error.message, /no claim on file:src\/parser\.mjs/);

  const status = await place.json(["status"]);
  assert.equal(status.body.data.claims.length, 1);
});
