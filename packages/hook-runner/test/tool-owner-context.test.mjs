import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createGrokAdapter } from "@agents-can-communicate/adapter-grok";
import { storeSessionBinding } from "@agents-can-communicate/adapter-sdk";
import { runHook } from "../src/runner.mjs";

async function stage(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-tool-owner-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataHome = path.join(root, "data");
  const adapter = createGrokAdapter();
  // The data home must be outside the workspace even in a test.
  const project = path.join(root, "project");
  await mkdir(project);
  const hook = (kind, native = "native-owner", options = {}) => runHook({
    adapterId: "grok", adapters: { grok: adapter }, dataHome,
    readProcessTable: async () => new Map(), probeClientVersion: async () => "1.0.24",
    payload: { hookEventName: kind, sessionId: native, cwd: project,
      toolName: "run_terminal_command", toolInput: { command: "printf nope > guarded.mjs" } },
    ...options,
  });
  const started = await hook("session_start");
  assert.equal(started.failed, undefined, started.reason);
  return { hook, started, adapter, dataHome };
}

test("Grok owner context cannot overwrite a real guard refusal", async t => {
  const { hook } = await stage(t);
  assert.match((await hook("pre_tool_use")).stdout, /ACC CLI/);
  const peer = await hook("session_start", "native-peer");
  await peer.service.acquireClaim({ sessionId: peer.accSessionId, generation: peer.generation,
    resource: "file:guarded.mjs", mode: "exclusive", enforcement: "guarded", reason: "held" });
  const denied = await hook("pre_tool_use");
  assert.equal(denied.decision, "deny");
  const output = JSON.parse(denied.stdout);
  assert.equal(output.decision, "deny");
  assert.equal(output.hookSpecificOutput, undefined);
});

test("a mismatched binding cannot lend the current open generation", async t => {
  const { hook, started, dataHome } = await stage(t);
  await storeSessionBinding({
    runtimeDir: path.join(dataHome, "acc", "workspaces", started.service.store.workspaceId),
    harnessSessionId: "native-owner", accSessionId: started.accSessionId,
    generation: "generation_wrong", clientVersion: "1.0.13",
  });
  const output = await hook("pre_tool_use");
  assert.equal(output.failed, undefined, output.reason);
  assert.equal(output.stdout, "", "a stale binding emitted usable-looking owner credentials");
});

test("an owner formatter failure remains a failed-open hook", async t => {
  const { hook, adapter } = await stage(t);
  const broken = { ...adapter, injectToolOwnerOutcome() { throw new Error("formatter failed"); } };
  const result = await hook("pre_tool_use", "native-owner", { adapters: { grok: broken } });
  assert.equal(result.failed, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.decision, "allow");
  assert.equal(result.stdout, "");
});
