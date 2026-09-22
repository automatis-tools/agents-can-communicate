import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runHook } from "../src/runner.mjs";

// One client hands its hooks no event name at all: Antigravity CLI sends no
// `hook_event_name`, and two of its four events carry byte-identical payloads.
// The name is in the command that was registered, so the runner has to pass the
// arguments it was invoked with to the adapter that knows what they mean.
const adapterWith = seen => ({
  id: "argument_reader",
  client: { command: "argument-reader", certificationName: "argument-reader",
    versionArgs: ["--version"] },
  capabilities: {},
  certification: { evidence: [] },
  normalizeHook: (payload, options) => {
    seen.push(options);
    return { kind: options?.args?.[0] === "PreInvocation" ? "beforeTurn" : "sessionStart",
      sessionId: payload.conversationId, cwd: payload.workspacePaths[0],
      model: null, parentSessionId: null, tool: null, targets: [] };
  },
  renderContext: () => "",
  injectOutcome: context => ({ stdout: context, stderr: "", exitCode: 0 }),
  denyOutcome: reason => ({ stdout: "", stderr: reason, exitCode: 0 }),
});

async function harness(t) {
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-args-")));
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "acc-args-ws-")));
  t.after(() => Promise.all([rm(dataHome, { recursive: true, force: true }),
    rm(cwd, { recursive: true, force: true })]));
  return { dataHome, payload: { conversationId: "conv-1", workspacePaths: [cwd] } };
}

test("the runner hands an adapter the arguments its hook command was given", async t => {
  const { dataHome, payload } = await harness(t);
  const seen = [];

  await runHook({ adapterId: "argument_reader", payload,
    adapters: { argument_reader: adapterWith(seen) },
    args: ["PreInvocation"], dataHome, env: {} });

  assert.equal(seen.length >= 1, true, "normalizeHook was never called");
  assert.deepEqual(seen[0]?.args, ["PreInvocation"],
    "an adapter whose payload has no event name cannot tell which hook ran");
});

test("an adapter that reads no arguments still gets a well-formed options object", async t => {
  const { dataHome, payload } = await harness(t);
  const seen = [];

  await runHook({ adapterId: "argument_reader", payload,
    adapters: { argument_reader: adapterWith(seen) }, dataHome, env: {} });

  assert.deepEqual(seen[0]?.args, [],
    "a missing argument list must arrive as an empty one, never undefined");
});
