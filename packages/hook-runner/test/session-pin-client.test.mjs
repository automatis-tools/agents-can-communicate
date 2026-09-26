import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { readPin, writePin } from "@agents-can-communicate/cli";

import { runHook } from "../src/runner.mjs";

const adapter = {
  id: "test_harness",
  client: { command: "test-harness", versionArgs: ["--version"] },
  capabilities: { guards: { beforeWrite: false }, lifecycle: { sessionEnd: true } },
  normalizeHook: payload => payload,
  injectOutcome: context => ({ stdout: context, stderr: "", exitCode: 0 }),
  renderContext: () => "",
};

async function place(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-pin-client-ws-")));
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-pin-client-data-")));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }),
    rm(dataHome, { recursive: true, force: true })]));
  return { root, dataHome, managerRoot: path.join(dataHome, "acc", "runtime") };
}

// The hook's own process sits under the client, as it does under a real one.
const CLIENT_PID = process.ppid;
const underClient = async () => new Map([[process.pid, { ppid: CLIENT_PID, comm: "node" }],
  [CLIENT_PID, { ppid: 1, comm: "test-harness" }]]);
const clientNotFound = async () => new Map();

const start = ({ root, dataHome }, readProcessTable) => runHook({
  adapterId: adapter.id,
  adapters: { [adapter.id]: adapter },
  dataHome,
  readProcessTable,
  probeClientVersion: async () => null,
  payload: { kind: "sessionStart", sessionId: "pinned-harness-session", cwd: root,
    model: null, parentSessionId: null, tool: null, targets: [] },
});

test("a session start whose client pid is unknown writes no pin", async t => {
  const workspace = await place(t);
  const started = await start(workspace, clientNotFound);
  assert.equal(started.failed, undefined, started.reason);
  assert.equal(await readPin({ root: workspace.managerRoot,
    harnessSessionId: "pinned-harness-session" }), null);
});

test("a repeated start re-pins the session with the client pid it already knew", async t => {
  const workspace = await place(t);
  const first = await start(workspace, underClient);
  assert.equal(first.failed, undefined, first.reason);
  const current = await readPin({ root: workspace.managerRoot, harnessSessionId: "pinned-harness-session" });
  assert.equal(current.clientPid, CLIENT_PID);

  // The session outlived an activation: its pin still names an older runtime.
  await writePin({ root: workspace.managerRoot, harnessSessionId: "pinned-harness-session",
    runtimeRoot: "/elsewhere/generations/0.4.0-old", version: "0.4.0", storeVersion: 6,
    clientPid: CLIENT_PID });
  // This start cannot find its client (a slow `ps`, say), so only the pid the
  // binding recorded can keep the refreshed pin reapable.
  const second = await start(workspace, clientNotFound);
  assert.equal(second.failed, undefined, second.reason);

  const refreshed = await readPin({ root: workspace.managerRoot, harnessSessionId: "pinned-harness-session" });
  assert.equal(refreshed.runtimeRoot, current.runtimeRoot);
  assert.equal(refreshed.clientPid, CLIENT_PID);
});
