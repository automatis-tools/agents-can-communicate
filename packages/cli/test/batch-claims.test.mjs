import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const binary = path.resolve(import.meta.dirname, "../../../bin/acc.mjs");
const owner = session => ["--session", session.sessionId, "--generation", session.generation];

async function fixture(t) {
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "acc-batch-cli-")));
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-batch-data-")));
  t.after(() => Promise.all([rm(cwd, { recursive: true, force: true }),
    rm(dataHome, { recursive: true, force: true })]));
  const env = { ...process.env, ACC_DATA_HOME: dataHome, GIT_DIR: "", GIT_WORK_TREE: "" };
  delete env.ACC_SESSION; delete env.ACC_GENERATION;
  const run = async args => {
    try {
      const { stdout } = await exec(process.execPath, [binary, ...args, "--json"], { cwd, env });
      return { code: 0, ...JSON.parse(stdout) };
    } catch (error) { return { code: error.code, ...JSON.parse(error.stdout) }; }
  };
  const attach = async participant => {
    const result = await run(["attach", "--participant", participant, "--harness", "cli"]);
    assert.equal(result.code, 0, JSON.stringify(result)); return result.data;
  };
  const raw = async args => exec(process.execPath, [binary, ...args], { cwd, env })
    .then(result => ({ code: 0, ...result }), error => ({ code: error.code, stdout: error.stdout,
      stderr: error.stderr }));
  return { run, raw, attach };
}

test("CLI batch claim and both release selector lists change the complete set", async t => {
  const f = await fixture(t), s = await f.attach("alice");
  const claimed = await f.run(["claim", ...owner(s), "--resource", "file:a.mjs",
    "--resource", "file:b.mjs", "--reason", "batch"]);
  assert.equal(claimed.code, 0, JSON.stringify(claimed));
  assert.deepEqual(claimed.data.claims.map(c => c.resource), ["file:a.mjs", "file:b.mjs"]);
  const ids = claimed.data.claims.map(c => c.claimId);
  const released = await f.run(["release", ...owner(s), "--claim", ids[0], "--claim", ids[1]]);
  assert.equal(released.code, 0, JSON.stringify(released));
  assert.deepEqual(released.data, { claimIds: ids });
  assert.equal((await f.run(["status"])).data.claims.length, 0);
  await f.run(["claim", ...owner(s), "--resource", "file:a.mjs", "--resource", "file:b.mjs"]);
  const byResource = await f.run(["release", ...owner(s), "--resource", "file:a.mjs",
    "--resource", "file:b.mjs"]);
  assert.equal(byResource.code, 0, JSON.stringify(byResource));
  assert.equal(byResource.data.claimIds.length, 2);
  assert.equal((await f.run(["status"])).data.claims.length, 0);
});

test("CLI scalar results and single-item force release remain compatible", async t => {
  const f = await fixture(t), a = await f.attach("alice"), b = await f.attach("bob");
  const claimed = await f.run(["claim", ...owner(a), "--resource", "file:a.mjs"]);
  assert.equal(claimed.data.resource, "file:a.mjs");
  assert.equal(claimed.data.claims, undefined);
  const forced = await f.run(["release", ...owner(b), "--resource", "file:a.mjs",
    "--authority", "human", "--reason", "fixture approval"]);
  assert.equal(forced.code, 0, JSON.stringify(forced));
  assert.deepEqual(forced.data, { claimId: claimed.data.claimId });
  const again = await f.run(["claim", ...owner(a), "--resource", "file:a.mjs"]);
  const released = await f.run(["release", ...owner(a), "--resource", "file:a.mjs"]);
  assert.deepEqual(released.data, { claimId: again.data.claimId });
});

test("CLI all releases only this owner and succeeds for a new solo session", async t => {
  const f = await fixture(t), a = await f.attach("alice");
  const empty = await f.run(["release", ...owner(a), "--all"]);
  assert.equal(empty.code, 0, JSON.stringify(empty));
  assert.deepEqual(empty.data, { claimIds: [] });
  const b = await f.attach("bob");
  await f.run(["work", ...owner(a), "--summary", "continues", "--mode", "edit"]);
  await f.run(["claim", ...owner(a), "--resource", "file:a.mjs", "--resource", "file:b.mjs"]);
  const theirs = await f.run(["claim", ...owner(b), "--resource", "file:c.mjs"]);
  const released = await f.run(["release", ...owner(a), "--all"]);
  assert.equal(released.data.claimIds.length, 2);
  const status = (await f.run(["status"])).data;
  assert.deepEqual(status.claims.map(c => c.claimId), [theirs.data.claimId]);
  assert.equal(status.participants.find(p => p.sessionId === a.sessionId).intent, "continues");
  assert.equal((await f.run(["claim", ...owner(a), "--resource", "file:d.mjs"])).code, 0);
});

test("CLI malformed selectors and an invalid last resource leave claims unchanged", async t => {
  const f = await fixture(t), a = await f.attach("alice");
  const initial = await f.run(["claim", ...owner(a), "--resource", "file:held.mjs"]);
  const before = (await f.run(["status"])).data.claims;
  for (const args of [
    ["claim", "--resource", "file:a.mjs", "--resource", "file:src/*"],
    ["claim", "--resource", "file:a.mjs", "--resource", "file:./a.mjs"],
    ["release", "--resource", "file:held.mjs", "--claim", initial.data.claimId],
    ["release", "--all", "--resource", "file:held.mjs"],
    ["release", "--all", "--authority", "human"],
    ["release", "--claim", initial.data.claimId, "--claim", initial.data.claimId],
  ]) {
    const result = await f.run([...args, ...owner(a)]);
    assert.equal(result.code, 2, JSON.stringify(result));
    assert.deepEqual((await f.run(["status"])).data.claims, before);
  }
});

test("CLI batch conflict identifies blockers without retaining earlier resources", async t => {
  const f = await fixture(t), a = await f.attach("alice"), b = await f.attach("bob");
  const blocked = await f.run(["claim", ...owner(b), "--resource", "file:b.mjs"]);
  const conflict = await f.run(["claim", ...owner(a), "--resource", "file:a.mjs",
    "--resource", "file:b.mjs"]);
  assert.equal(conflict.code, 5, JSON.stringify(conflict));
  assert.equal(conflict.error.details.conflicts[0].ownerSessionId, b.sessionId);
  assert.deepEqual((await f.run(["status"])).data.claims.map(c => c.claimId), [blocked.data.claimId]);
});

test("plain CLI batch errors name every requested resource and blocking owner", async t => {
  const f = await fixture(t), a = await f.attach("alice"), b = await f.attach("bob");
  await f.run(["claim", ...owner(b), "--resource", "file:blocked/**",
    "--resource", "file:other.mjs"]);
  const denied = await f.raw(["claim", ...owner(a), "--resource", "file:blocked/a.mjs",
    "--resource", "file:other.mjs"]);
  assert.equal(denied.code, 5);
  for (const value of ["file:blocked/a.mjs", "file:blocked/**", "file:other.mjs", b.sessionId]) {
    assert.equal(denied.stderr.includes(value), true, `plain error omitted ${value}: ${denied.stderr}`);
  }
});
