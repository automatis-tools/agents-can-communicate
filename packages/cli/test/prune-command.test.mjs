import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { main } from "../src/main.mjs";

const START = Date.parse("2026-09-24T01:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

// The project and the data home are siblings on purpose: ACC refuses to treat a
// directory that contains its own state as a workspace, and says so.
async function workspace(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-prune-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "project");
  await mkdir(cwd, { recursive: true });
  return { root, cwd, dataHome: path.join(root, "home") };
}

async function run(argv, { root, cwd, dataHome }, at = START) {
  let text = "";
  const stdout = { write: (chunk, done) => { text += chunk; done?.(); return true; } };
  const code = await main([...argv, "--cwd", cwd, "--json"], {
    cwd, env: { HOME: root, ACC_DATA_HOME: dataHome }, platform: process.platform,
    stdout, stderr: { write: (_chunk, done) => { done?.(); return true; } },
    clock: { now: () => new Date(at).toISOString() },
    ids: { next: kind => `${kind}_${Math.random().toString(36).slice(2, 10)}` },
  });
  return { code, payload: text.trim() === "" ? null : JSON.parse(text) };
}

// Two participants materialise the workspace, which is where durable records
// live and the only place there is anything to prune.
async function twoSessions(place) {
  await run(["attach", "--participant", "one", "--harness", "cli"], place);
  await run(["attach", "--participant", "two", "--harness", "cli"], place);
}

test("prune reports what it would reclaim and changes nothing", async t => {
  const place = await workspace(t);
  await twoSessions(place);

  const { code, payload } = await run(["prune"], place, START + 2 * DAY);

  assert.equal(code, 0);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.applied, false);
  assert.equal(payload.data.reclaimed, 0);
  assert.equal(payload.data.counts.sessions, 2);

  // Nothing changed, so asking again says exactly the same thing.
  const again = await run(["prune"], place, START + 2 * DAY);
  assert.equal(again.payload.data.counts.sessions, 2);
});

test("prune --apply reclaims what the report named", async t => {
  const place = await workspace(t);
  await twoSessions(place);

  const { code, payload } = await run(["prune", "--apply"], place, START + 2 * DAY);

  assert.equal(code, 0);
  assert.equal(payload.data.applied, true);
  assert.ok(payload.data.reclaimed > 0);

  // A second run has nothing left to name.
  const after = await run(["prune"], place, START + 2 * DAY);
  assert.equal(after.payload.data.counts.sessions, 0);
});

test("a live session is never named", async t => {
  const place = await workspace(t);
  await twoSessions(place);

  const { payload } = await run(["prune"], place, START + 60_000);

  // A minute later both sessions are online. Only a confirmed dead process or
  // a full day of silence makes a session something to reclaim.
  assert.equal(payload.data.counts.sessions, 0);
  assert.equal(payload.data.counts.participants, 0);
});

test("a class the store does not have is refused", async t => {
  const place = await workspace(t);
  await twoSessions(place);

  const { code, payload } = await run(["prune", "--class", "everything"], place);

  // EXIT.USAGE. The named classes are a closed set, and a misspelt one that
  // silently pruned nothing would read as "there was nothing to prune".
  assert.equal(code, 2);
  assert.match(payload.error.message, /prune class is one of/);
});
