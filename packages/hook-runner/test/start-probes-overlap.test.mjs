import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runHook } from "../src/runner.mjs";

const delay = ms => new Promise(resolve => { setTimeout(resolve, ms); });

// A session start asks the client for its version and reads the process table
// to find the client's pid. Neither needs the other. On Windows the first starts
// the client (`--version` through PATHEXT) and the second starts PowerShell, and
// one after the other they took most of the hook's five seconds on a loaded
// windows-latest runner, leaving too little for the session's own writes.
test("a session start reads the process table while the client reports its version", async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-start-probes-")));
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-start-probes-data-")));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }),
    rm(dataHome, { recursive: true, force: true })]));
  const seen = {};
  const adapter = {
    id: "fixture",
    client: { command: "fixture" },
    capabilities: {},
    normalizeHook: payload => payload,
    injectOutcome: context => ({ stdout: context, stderr: "", exitCode: 0 }),
    renderContext: () => "",
  };

  const result = await runHook({
    adapterId: adapter.id,
    adapters: { [adapter.id]: adapter },
    dataHome,
    payload: { kind: "sessionStart", sessionId: "overlap", cwd: root, targets: [] },
    probeClientVersion: async () => {
      seen.versionStarted = performance.now();
      await delay(300);
      seen.versionEnded = performance.now();
      return "1.0.0";
    },
    readProcessTable: async () => {
      seen.tableStarted = performance.now();
      await delay(300);
      return new Map();
    },
  });

  assert.equal(result.failed, undefined, result.reason);
  assert.equal(result.sessions.length, 1);
  assert.ok(seen.tableStarted < seen.versionEnded,
    `the process table waited for the version probe: ${JSON.stringify(seen)}`);
});
