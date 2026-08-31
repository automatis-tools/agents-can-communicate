import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

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
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-compaction-ws-")));
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-compaction-data-")));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }),
    rm(dataHome, { recursive: true, force: true })]));
  return { root, dataHome };
}

const start = ({ root, dataHome }) => runHook({
  adapterId: adapter.id,
  adapters: { [adapter.id]: adapter },
  dataHome,
  readProcessTable: async () => new Map(),
  payload: { kind: "sessionStart", sessionId: "same-harness-session", cwd: root,
    model: null, parentSessionId: null, tool: null, targets: [] },
});

test("a repeated SessionStart after compaction resumes the bound ACC session", async t => {
  const workspace = await place(t);

  const before = await start(workspace);
  const after = await start(workspace);

  assert.equal(after.failed, undefined, after.reason);
  assert.equal(after.accSessionId, before.accSessionId);
  assert.equal(after.generation, before.generation);
  assert.equal(after.sessions.length, 1,
    "compaction left an old open session beside its replacement");
});
