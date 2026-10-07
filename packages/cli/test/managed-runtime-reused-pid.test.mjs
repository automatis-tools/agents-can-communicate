import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { activatePending, processStartedAt, sweepStaleBindings } from "../src/managed-runtime/activation.mjs";
import { writeControl } from "../src/managed-runtime/state.mjs";

/**
 * A binding whose pid the operating system gave to another program (#276).
 *
 * On 2026-10-06, with 0.10.1 pending on the maintainer's Mac, 3 of the 6
 * processes holding it were not ACC clients: chrome-devtools-mcp and two
 * IntelliJ Tailwind helpers had the pids of Claude Code sessions from
 * 2026-09-30, 2026-10-01 and 2026-10-05, and each had started after its
 * binding was last written. A client runs when it writes its binding.
 */

const HOUR = 60 * 60_000;
const alive = () => true;

async function fixture(t) {
  const data = await realpath(await mkdtemp(path.join(tmpdir(), "acc-reused-pid-")));
  t.after(() => rm(data, { recursive: true, force: true }));
  const root = path.join(data, "acc", "runtime");
  const active = { version: "0.9.1", root: path.join(root, "generations", "old"), storeVersion: 6 };
  const pending = { version: "0.10.2", root: path.join(root, "generations", "new"), storeVersion: 7 };
  await mkdir(active.root, { recursive: true });
  await mkdir(pending.root, { recursive: true });
  await writeControl(root, { schemaVersion: 1, active, pending, phase: "ready", auto: true,
    pin: null, checkedAt: null, home: path.join(data, "home"), targets: [], notice: null });
  const bindings = path.join(data, "acc", "workspaces", "workspace_fixture", "bindings");
  await mkdir(bindings, { recursive: true });
  // Written `ageMs` ago by a client with this pid.
  const bind = async (name, clientPid, ageMs) => {
    const file = path.join(bindings, `${name}.json`);
    await writeFile(file, JSON.stringify({ schemaVersion: 1, harnessSessionId: name,
      accSessionId: `session_${name}`, generation: `generation_${name}`, clientPid, storeVersion: 6 }));
    const when = new Date(Date.now() - ageMs);
    await utimes(file, when, when);
  };
  const remaining = async () => (await readdir(bindings)).sort();
  const activate = startedAt => activatePending(root, { pidIsAlive: alive, startedAt,
    prepare: async () => async () => ({ failed: [] }) });
  return { root, bind, remaining, activate };
}

test("a binding whose pid now belongs to a process that started after it was written does not block", async t => {
  const f = await fixture(t);
  await f.bind("reused", 4242, 48 * HOUR);

  const result = await f.activate(async () => Date.now() - HOUR);

  assert.equal(result.activated, true, JSON.stringify(result));
});

test("a binding whose client started before it was written still blocks", async t => {
  const f = await fixture(t);
  await f.bind("client", 4242, HOUR);

  const result = await f.activate(async () => Date.now() - 2 * HOUR);

  assert.equal(result.activated, false);
  assert.deepEqual(result.blockers.map(blocker => blocker.pid), [4242]);
});

test("a binding whose process start time cannot be read still blocks", async t => {
  const f = await fixture(t);
  await f.bind("unknown", 4242, 48 * HOUR);

  const result = await f.activate(async () => null);

  assert.equal(result.activated, false);
});

// An older generation counts a reused pid as a live client, so the sweep that
// the pending generation's refresh runs removes those bindings - and only those.
test("the sweep removes a binding whose pid was reused and keeps a live client's", async t => {
  const f = await fixture(t);
  await f.bind("reused", 4242, 48 * HOUR);
  await f.bind("client", 4343, HOUR);
  const startedAt = async pid => (pid === 4242 ? Date.now() - HOUR : Date.now() - 2 * HOUR);

  const removed = await sweepStaleBindings(f.root, { pidIsAlive: alive, startedAt });

  assert.equal(removed, 1);
  assert.deepEqual(await f.remaining(), ["client.json"]);
});

test("the start time of a running process is read from the operating system", async () => {
  const started = await processStartedAt(process.pid);
  const expected = Date.now() - process.uptime() * 1000;

  assert.equal(typeof started, "number");
  assert.ok(Math.abs(started - expected) < 5_000, `${started} vs ${expected}`);
});
